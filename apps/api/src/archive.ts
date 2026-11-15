import { boundedText, normalizeEnclosures } from "./metadata.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import {
  type DB,
  withConnection,
  type Row,
  type Store,
  id,
  hash,
  iso,
  ApiFailure,
} from "./core.js";
import { Articles } from "./articles.js";
import { Annotations, annotationDocument, notesBackup } from './annotations.js';
import { archivedAnnotationSchema, validateArchivedAnnotations, restoreArchivedAnnotations } from './annotation-archive.js';
import {
  ARTICLE_HTML_MAX_LENGTH,
  cleanHtml,
  htmlText,
  countWords,
  raster,
} from "./content.js";
import { makeZip, readZip, ZIP_LIMIT } from "./zip.js";
import { preferences, uuid, color } from "./validation.js";
const text = z.string().max(ARTICLE_HTML_MAX_LENGTH),
  label = z.string().max(1000),
  date = z.iso.datetime();
const externalUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  });
const manifestSchema = z
  .object({
    format: z.literal("feedink-archive"),
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    exportedAt: date,
    folders: z
      .array(
        z.object({
          id: uuid,
          name: z.string().min(1).max(160),
          position: z.number().int(),
          settings: preferences,
        }),
      )
      .max(1000),
    feeds: z
      .array(
        z.object({
          id: uuid,
          url: externalUrl,
          title: label,
          siteUrl: z.union([externalUrl, z.literal("")]),
          description: z.string().max(4000),
        }),
      )
      .max(1000),
    subscriptions: z
      .array(
        z.object({
          id: uuid,
          feedId: uuid,
          title: label,
          folderId: uuid.nullable(),
          position: z.number().int(),
          settings: preferences,
        }),
      )
      .max(1000),
    tags: z
      .array(z.object({ id: uuid, name: z.string().min(1).max(160), color }))
      .max(1000),
    articles: z
      .array(
        z.object({
          id: uuid,
          feedId: uuid.nullable(),
          guid: z.string().max(4096),
          feedTitle: label,
          title: label,
          url: externalUrl,
          author: label.nullable(),
          publishedAt: date,
          archivedAt: date,
          fetchedAt: date,
          fulltextFetchedAt: date.nullable().optional(),
          contentHtml: text,
          fulltextHtml: text.nullable(),
          fulltextError: z.string().max(1000).nullable(),
          read: z.boolean(),
          saved: z.boolean(),
          progress: z.number().min(0).max(1),
          tagIds: z.array(uuid).max(100),
          enclosures: z
            .array(
              z.object({
                url: externalUrl,
                type: z.string().max(200),
                length: z.number().nonnegative().optional(),
              }),
            )
            .max(10),
          annotations: z.array(archivedAnnotationSchema).max(1000).optional(),
          images: z
            .array(
              z.object({
                id: uuid,
                originalUrl: externalUrl,
                status: z.enum(["cached", "pending", "failed"]),
                path: z.string().nullable(),
                capturedAt: date.nullable().optional(),
                lastError: z.string().max(1000).nullable().optional(),
              }),
            )
            .max(100),
        }),
      )
      .max(1000),
  })
  .strict();
export class Archives {
  constructor(
    readonly db: DB,
    readonly store: Store,
    readonly articles: Articles,
  ) {}
  async export(userId: string) {
    return withConnection(this.db, async (db) => {
      await db`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      try {
        const [{ count, article_bytes }] =
          await db`SELECT count(*)::integer AS count,coalesce(sum(octet_length((to_jsonb(a)-'content_text'-'summary')::text)+512),0)::text AS article_bytes FROM articles a WHERE user_id=${userId}`;
        if (count > 1000)
          throw new ApiFailure(
            413,
            "ARCHIVE_LIMIT",
            "Archive supports at most 1000 articles",
          );
        const [{ image_count, image_bytes }] =
          await db`SELECT count(*)::integer AS image_count,coalesce(sum(octet_length(to_jsonb(i)::text)+256),0)::text AS image_bytes FROM images i JOIN articles a ON a.id=i.article_id WHERE a.user_id=${userId}`;
        const [{ metadata_bytes }] =
          await db`SELECT coalesce(sum(bytes),0)::text AS metadata_bytes FROM (
        SELECT octet_length(to_jsonb(f)::text)+128 AS bytes FROM feeds f WHERE user_id=${userId}
        UNION ALL SELECT octet_length(to_jsonb(s)::text)+128 FROM subscriptions s WHERE user_id=${userId}
        UNION ALL SELECT octet_length(to_jsonb(f)::text)+128 FROM folders f WHERE user_id=${userId}
        UNION ALL SELECT octet_length(to_jsonb(t)::text)+128 FROM tags t WHERE user_id=${userId}
        UNION ALL SELECT 64 FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE a.user_id=${userId}
        UNION ALL SELECT octet_length((to_jsonb(n)-'search_text')::text)+512 FROM annotations n WHERE n.user_id=${userId}) sizes`;
        if (
          image_count + 1 > 6000 ||
          Number(article_bytes) +
            Number(image_bytes) +
            Number(metadata_bytes) +
            8192 >
            16 * 1024 * 1024
        )
          throw new ApiFailure(
            413,
            "ARCHIVE_LIMIT",
            "Archive manifest exceeds its bounded budget; use an operator backup",
          );
        const rows =
          await db`SELECT id FROM articles WHERE user_id=${userId} ORDER BY archived_at,id`;

        if (rows.length > 1000)
          throw new ApiFailure(
            413,
            "ARCHIVE_LIMIT",
            "Archive export supports at most 1000 articles; use the operator database/volume backup for larger collections",
          );
        const files: { name: string; data: Buffer }[] = [],
          articleRecords = [];
        let bytes = 0,
          manifestBytes = 0;
        for (const item of rows) {
          const [row] =
            await db`SELECT id,feed_id,guid,feed_title,title,url,author,published_at,archived_at,fetched_at,fulltext_fetched_at,content_html,fulltext_html,fulltext_error,read,saved,progress,enclosures FROM articles WHERE id=${item.id}`;
          const images =
            await db`SELECT * FROM images WHERE article_id=${row.id}`;
          const tagRows =
            await db`SELECT tag_id FROM article_tags WHERE article_id=${row.id}`;
          for (const image of images)
            if (image.status === "cached") {
              bytes += await this.store.size(image.file_key);
              if (bytes > ZIP_LIMIT)
                throw new ApiFailure(
                  413,
                  "ARCHIVE_LIMIT",
                  "Archive content exceeds 128 MiB",
                );
              files.push({
                name: `images/${image.id}.png`,
                data: await this.store.get(image.file_key),
              });
            }
          const noteRows = await db`SELECT * FROM annotations WHERE article_id=${row.id} AND user_id=${userId} ORDER BY mode,content_hash LIMIT 1001`;
          if (noteRows.length > 1000) throw new ApiFailure(413, 'ARCHIVE_LIMIT', 'Article has too many annotated snapshots; use an operator backup');
          const annotations = noteRows.map(n => ({ backup: notesBackup(annotationDocument(n)), contentHtml: n.content_html, revision: n.revision, updatedAt: iso(n.updated_at) }));
          validateArchivedAnnotations(annotations, row.url, new Map(images.map(i => [i.id, i.original_url])));
          const record = {
            id: row.id,
            annotations,
            feedId: row.feed_id,
            guid: row.guid,
            feedTitle: boundedText(row.feed_title, 1000),
            title: boundedText(row.title, 1000),
            url: row.url,
            author: row.author === null ? null : boundedText(row.author, 1000),
            publishedAt: iso(row.published_at),
            archivedAt: iso(row.archived_at),
            fetchedAt: iso(row.fetched_at),
            fulltextFetchedAt: row.fulltext_fetched_at
              ? iso(row.fulltext_fetched_at)
              : null,
            contentHtml: row.content_html,
            fulltextHtml: row.fulltext_html,
            fulltextError: row.fulltext_error
              ? boundedText(row.fulltext_error, 1000)
              : null,
            read: row.read,
            saved: row.saved,
            progress: row.progress,
            tagIds: tagRows.map((t) => t.tag_id),
            enclosures: normalizeEnclosures(row.enclosures, row.url),
            images: images.map((i) => ({
              id: i.id,
              originalUrl: i.original_url,
              status: i.status,
              capturedAt: i.captured_at ? iso(i.captured_at) : null,
              lastError: i.last_error ? boundedText(i.last_error, 1000) : null,
              path: i.status === "cached" ? `images/${i.id}.png` : null,
            })),
          };
          manifestBytes += Buffer.byteLength(JSON.stringify(record));
          if (manifestBytes > 16 * 1024 * 1024)
            throw new ApiFailure(
              413,
              "ARCHIVE_LIMIT",
              "Archive manifest budget exceeded",
            );
          articleRecords.push(record);
        }
        const feeds = await db`SELECT * FROM feeds WHERE user_id=${userId}`,
          subscriptions =
            await db`SELECT * FROM subscriptions WHERE user_id=${userId}`,
          folders = await db`SELECT * FROM folders WHERE user_id=${userId}`,
          tags = await db`SELECT * FROM tags WHERE user_id=${userId}`;
        if (
          [feeds, subscriptions, folders, tags].some(
            (records) => records.length > 1000,
          )
        )
          throw new ApiFailure(
            413,
            "ARCHIVE_LIMIT",
            "Archive supports at most 1000 feeds, subscriptions, folders or tags; use an operator backup for larger libraries",
          );
        const manifest = {
          format: "feedink-archive",
          version: 3,
          exportedAt: new Date().toISOString(),
          articles: articleRecords,
          feeds: feeds.map((f) => ({
            id: f.id,
            url: f.url,
            title: boundedText(f.title, 1000),
            siteUrl: f.site_url,
            description: boundedText(f.description, 4000),
          })),
          subscriptions: subscriptions.map((s) => ({
            id: s.id,
            feedId: s.feed_id,
            title: boundedText(s.title, 1000),
            folderId: s.folder_id,
            position: s.position,
            settings: s.settings,
          })),
          folders: folders.map((f) => ({
            id: f.id,
            name: f.name,
            position: f.position,
            settings: f.settings,
          })),
          tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        };
        const validated = manifestSchema.safeParse(manifest);
        if (!validated.success)
          throw new ApiFailure(
            422,
            "ARCHIVE_METADATA",
            "Stored metadata cannot be exported safely; repair the affected records before exporting",
          );
        const data = Buffer.from(JSON.stringify(validated.data));
        if (data.length > 16 * 1024 * 1024)
          throw new ApiFailure(413, "ARCHIVE_LIMIT", "Manifest exceeds 16 MiB");
        const result = await makeZip([
          { name: "manifest.json", data },
          ...files,
        ]);
        await db`COMMIT`;
        return result;
      } catch (e) {
        await db`ROLLBACK`;
        throw e;
      }
    });
  }
  async import(userId: string, buffer: Buffer) {
    const files = await readZip(buffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('manifest.json') || Buffer.alloc(0)));
    } catch {
      throw new ApiFailure(
        422,
        "INVALID_ARCHIVE",
        "Missing or invalid manifest.json",
      );
    }
    const result = manifestSchema.safeParse(parsed);
    if (!result.success)
      throw new ApiFailure(
        422,
        "INVALID_ARCHIVE",
        "Manifest schema is invalid or unsupported",
      );
    const manifest = result.data,
      expected = new Set(["manifest.json"]),
      allIds = new Set<string>();
    const [owner] = await this.db`SELECT is_demo FROM users WHERE id=${userId}`;
    if (owner?.is_demo) {
      const [{ count }] = await this
          .db`SELECT count(*)::integer AS count FROM articles WHERE user_id=${userId}`,
        [{ subscriptions }] = await this
          .db`SELECT count(*)::integer AS subscriptions FROM subscriptions WHERE user_id=${userId}`;
      if (
        count + manifest.articles.length > 100 ||
        subscriptions + manifest.subscriptions.length > 9
      )
        throw new ApiFailure(
          429,
          "DEMO_QUOTA",
          "Demo import would exceed 100 articles or nine subscriptions; register for your own library",
        );
    }
    for (const resource of [
      ...manifest.folders,
      ...manifest.feeds,
      ...manifest.subscriptions,
      ...manifest.tags,
      ...manifest.articles,
      ...manifest.articles.flatMap((a) => a.images),
    ]) {
      if (allIds.has(resource.id))
        throw new ApiFailure(
          422,
          "INVALID_ARCHIVE",
          "Duplicate resource identifier",
        );
      allIds.add(resource.id);
    }
    const feedSet = new Set(manifest.feeds.map((f) => f.id)),
      folderSet = new Set(manifest.folders.map((f) => f.id)),
      tagSet = new Set(manifest.tags.map((t) => t.id));
    for (const s of manifest.subscriptions)
      if (!feedSet.has(s.feedId) || (s.folderId && !folderSet.has(s.folderId)))
        throw new ApiFailure(
          422,
          "INVALID_ARCHIVE",
          "Invalid subscription reference",
        );
    const cached = new Map<string, { key: string; type: string }>();
    for (const article of manifest.articles) {
      if (manifest.version !== 3 && article.annotations?.length) throw new ApiFailure(422, 'INVALID_ARCHIVE', 'Notes require archive version 3');
      validateArchivedAnnotations(article.annotations ?? [], article.url, new Map(article.images.map(i => [i.id, i.originalUrl])));
      if (
        new Set(article.images.map((i) => i.originalUrl)).size !==
        article.images.length
      )
        throw new ApiFailure(
          422,
          "INVALID_ARCHIVE",
          "Duplicate article image URL",
        );
      if (
        (article.feedId && !feedSet.has(article.feedId)) ||
        article.tagIds.some((t) => !tagSet.has(t))
      )
        throw new ApiFailure(
          422,
          "INVALID_ARCHIVE",
          "Invalid article reference",
        );
      for (const image of article.images)
        if (image.status === "cached") {
          const path = `images/${image.id}.png`;
          if (image.path !== path || !files.has(path))
            throw new ApiFailure(
              422,
              "INVALID_ARCHIVE",
              "Missing or invalid image entry",
            );
          expected.add(path);
        }
    }
    if ([...files.keys()].some((k) => !expected.has(k)))
      throw new ApiFailure(422, "INVALID_ARCHIVE", "Unexpected archive file");
    // Validate bytes before any filesystem writes. Rejected archives leave no staged or permanent blobs.
    let normalizedBytes = 0;
    for (const article of manifest.articles)
      for (const image of article.images)
        if (image.status === "cached") {
          const result = await raster(files.get(image.path!)!);
          normalizedBytes += result.bytes.length;
          if (normalizedBytes > ZIP_LIMIT)
            throw new ApiFailure(
              413,
              "ARCHIVE_LIMIT",
              "Decoded archive images exceed 128 MiB",
            );
        }
    return withConnection(this.db, async (tx) =>
      this.store.writeTransaction(tx, async (put) => {
        let imported = 0,
          skipped = 0;
        const folders = new Map<string, string>(),
          feeds = new Map<string, string>(),
          tags = new Map<string, string>();
        for (const f of manifest.folders) {
          const [existing] =
            await tx`SELECT id FROM folders WHERE user_id=${userId} AND name=${f.name}`;
          const mapped = existing?.id || id();
          folders.set(f.id, mapped);
          if (!existing)
            await tx`INSERT INTO folders(id,user_id,name,position,settings) VALUES(${mapped},${userId},${f.name},${f.position},${tx.json(f.settings)})`;
        }
        for (const f of manifest.feeds) {
          const [row] =
            await tx`INSERT INTO feeds(id,user_id,url,title,site_url,description) VALUES(${id()},${userId},${f.url},${f.title},${f.siteUrl},${f.description}) ON CONFLICT(user_id,url) DO UPDATE SET url=EXCLUDED.url RETURNING id`;
          feeds.set(f.id, row.id);
        }
        for (const s of manifest.subscriptions)
          await tx`INSERT INTO subscriptions(id,user_id,feed_id,title,folder_id,position,settings) VALUES(${id()},${userId},${feeds.get(s.feedId)!},${s.title},${s.folderId ? folders.get(s.folderId)! : null},${s.position},${tx.json(s.settings)}) ON CONFLICT(feed_id) DO NOTHING`;
        for (const t of manifest.tags) {
          const [row] =
            await tx`INSERT INTO tags(id,user_id,name,color) VALUES(${id()},${userId},${t.name},${t.color}) ON CONFLICT(user_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
          tags.set(t.id, row.id);
        }
        for (const a of manifest.articles) {
          const feedId = a.feedId ? feeds.get(a.feedId)! : null;
          const duplicate = feedId
            ? await tx`SELECT id,url FROM articles WHERE user_id=${userId} AND feed_id=${feedId} AND guid=${a.guid} FOR UPDATE`
            : await tx`SELECT id,url FROM articles WHERE user_id=${userId} AND feed_id IS NULL AND url=${a.url} FOR UPDATE`;
          if (duplicate.length && !a.annotations?.length) {
            skipped++;
            continue;
          }
          if (duplicate.length && duplicate[0].url !== a.url) throw new ApiFailure(409, 'ANNOTATION_CONTEXT', 'Duplicate article source differs from archived notes');
          const articleId = duplicate[0]?.id || id();
          const existingImages = duplicate.length ? await tx`SELECT id,original_url FROM images WHERE article_id=${articleId}` : [];
          if (new Set([...existingImages.map(i => i.original_url), ...a.images.map(i => i.originalUrl)]).size > 100) throw new ApiFailure(413, 'ARCHIVE_LIMIT', 'Restoring annotated snapshots would exceed the article image limit');
          const images = new Map(a.images.map(i => [i.id, existingImages.find(existing => existing.original_url === i.originalUrl)?.id || id()]));
          const rewrite = (input: string) => {
            const $ = cheerio.load(input, {}, false);
            $("img").each((_, el) => {
              const old = $(el)
                  .attr("src")
                  ?.match(/^\/api\/assets\/([a-f0-9-]{36})$/)?.[1],
                mapped = old ? images.get(old) : null;
              if (mapped) $(el).attr("src", `/api/assets/${mapped}`);
              else $(el).remove();
            });
            return cleanHtml($.html());
          };
          const html = rewrite(a.contentHtml),
            fulltext = a.fulltextHtml ? rewrite(a.fulltextHtml) : null,
            body = htmlText(fulltext || html);
          if (!duplicate.length) await tx`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,author,published_at,archived_at,fetched_at,content_html,fulltext_html,fulltext_hash,content_text,content_hash,fulltext_error,summary,word_count,enclosures,read,saved,progress,fulltext_fetched_at,restored_at) VALUES(${articleId},${userId},${feedId},${a.guid},${a.feedTitle},${a.title},${a.url},${a.author},${a.publishedAt},${a.archivedAt},${a.fetchedAt},${html},${fulltext},${fulltext ? hash(fulltext) : null},${body},${hash(html)},${a.fulltextError},${body.slice(0, 400)},${countWords(body)},${tx.json(a.enclosures)},${a.read},${a.saved},${a.progress},${a.fulltextFetchedAt ?? null},now())`;
          for (const image of a.images) {
            if (existingImages.some(existing => existing.original_url === image.originalUrl)) continue;
            let file = cached.get(image.id);
            if (image.status === "cached" && !file) {
              const { bytes, type } = await raster(files.get(image.path!)!);
              file = { key: await put(bytes), type };
              cached.set(image.id, file);
            }
            await tx`INSERT INTO images(id,article_id,original_url,status,content_type,file_key,content_hash,captured_at,last_error,restored_at) VALUES(${images.get(image.id)!},${articleId},${image.originalUrl},${file ? "cached" : image.status},${file?.type || null},${file?.key || null},${file?.key || null},${image.capturedAt ?? null},${image.lastError ?? null},now())`;
          }
          await restoreArchivedAnnotations(tx, new Annotations(this.db), userId, articleId, a.url, a.annotations ?? [], rewrite);
          if (duplicate.length) skipped++;
          else {
            for (const tagId of new Set(a.tagIds))
              await tx`INSERT INTO article_tags(article_id,tag_id) VALUES(${articleId},${tags.get(tagId)!})`;
            imported++;
          }
        }
        return { imported, skipped, errors: [] as string[] };
      }),
    );
  }
}
