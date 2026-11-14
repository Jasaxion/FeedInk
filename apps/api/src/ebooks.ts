import { xmlCharacters } from "./metadata.js";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";
import type { Ebook } from "@feedink/shared";
import {
  type DB,
  type SQL,
  withConnection,
  type Row,
  type Store,
  id,
  iso,
  settingsFor,
  ApiFailure,
  safeError,
} from "./core.js";
import { escapeXml } from "./feeds.js";
import { makeZip, ZIP_LIMIT } from "./zip.js";
export const ebookDto = (row: Row): Ebook => ({
  id: row.id,
  title: row.title,
  createdAt: iso(row.created_at),
  articleCount: row.article_count,
  downloadUrl: `/api/ebooks/${row.id}/download`,
  sentAt: row.sent_at ? iso(row.sent_at) : null,
  error: row.error,
});
export class Ebooks {
  constructor(
    readonly db: DB,
    readonly store: Store,
  ) {}
  async create(
    user: Row,
    articleIds: string[],
    title = "FeedInk 阅读集",
    send = false,
    scheduleKey: string | null = null,
    connection?: SQL,
  ): Promise<Ebook> {
    return withConnection(
      this.db,
      async (db) => {
        const unique = [...new Set(articleIds)];
        if (!unique.length || unique.length > 100)
          throw new ApiFailure(
            400,
            "EBOOK_LIMIT",
            "Choose between 1 and 100 articles",
          );
        const rows =
          await db`SELECT * FROM articles WHERE user_id=${user.id} AND id IN ${db(unique)}`;
        if (rows.length !== unique.length)
          throw new ApiFailure(
            404,
            "NOT_FOUND",
            "One or more articles were not found",
          );
        if (send && user.is_demo)
          throw new ApiFailure(
            403,
            "DEMO_RESTRICTED",
            "Demo accounts cannot send email",
          );
        const ebookId = id();
        const [created] =
          await db`INSERT INTO ebooks(id,user_id,title,article_count,schedule_key,error) VALUES(${ebookId},${user.id},${title},${unique.length},${scheduleKey},'Generation interrupted; create a new ebook to retry') ON CONFLICT(user_id,schedule_key) DO NOTHING RETURNING *`;
        if (!created) {
          const [existing] =
            await db`SELECT * FROM ebooks WHERE user_id=${user.id} AND schedule_key=${scheduleKey}`;
          return ebookDto(existing);
        }
        let delivering = false;
        try {
          for (const articleId of unique)
            await db`INSERT INTO ebook_articles(ebook_id,article_id) VALUES(${ebookId},${articleId})`;
          const settings = settingsFor(user),
            files: { name: string; data: Buffer; compress?: boolean }[] = [
              {
                name: "mimetype",
                data: Buffer.from("application/epub+zip"),
                compress: false,
              },
              {
                name: "META-INF/container.xml",
                data: Buffer.from(
                  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
                ),
              },
            ];
          const manifest: string[] = [
              '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
            ],
            spine: string[] = [],
            navigation: string[] = [];
          let size = 0;
          for (const [index, articleId] of unique.entries()) {
            const article = rows.find((r) => r.id === articleId)!,
              $ = cheerio.load(
                xmlCharacters(article.fulltext_html || article.content_html),
                {},
                false,
              );
            const images =
              await db`SELECT * FROM images WHERE article_id=${articleId} AND status='cached'`;
            for (const image of images) {
              const name = `images/${image.id}.png`,
                bytes = await this.store.get(image.file_key);
              size += bytes.length;
              if (size > ZIP_LIMIT / 2)
                throw new ApiFailure(
                  413,
                  "EBOOK_LIMIT",
                  "Ebook images exceed 64 MiB",
                );
              files.push({ name: `OEBPS/${name}`, data: bytes });
              manifest.push(
                `<item id="i${image.id}" href="${name}" media-type="image/png"/>`,
              );
            }
            $("img").each((_, el) => {
              const asset = $(el).attr("src")?.split("/").at(-1),
                image = images.find((i) => i.id === asset);
              if (image) $(el).attr("src", `images/${image.id}.png`);
              else $(el).replaceWith("<span>[Image unavailable]</span>");
              $(el).removeAttr("loading");
            });
            if (!settings.ebookKeepLinks)
              $("a").each((_, el) => {
                $(el).replaceWith($(el).contents());
              });
            // HTML numeric entities may decode to forbidden XML scalars; clean
            // the parsed text/attributes before the XML serializer re-encodes them.
            const elements = $("*");
            elements.each((_, element) => {
              if ("attribs" in element)
                for (const key of Object.keys(element.attribs))
                  element.attribs[key] = xmlCharacters(element.attribs[key]);
            });
            elements
              .add($.root())
              .contents()
              .each((_, node) => {
                if (node.type === "text") node.data = xmlCharacters(node.data);
              });
            const body = $.xml(),
              filename = `article-${index}.xhtml`;
            const content = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(settings.ebookLanguage)}"><head><title>${escapeXml(article.title)}</title></head><body><h1>${escapeXml(article.title)}</h1><p>${escapeXml(article.feed_title)} · ${iso(article.published_at).slice(0, 10)}</p>${body}${settings.ebookKeepLinks ? `<p><a href="${escapeXml(article.url)}">Original article</a></p>` : ""}</body></html>`;
            files.push({
              name: `OEBPS/${filename}`,
              data: Buffer.from(content),
            });
            manifest.push(
              `<item id="a${index}" href="${filename}" media-type="application/xhtml+xml"/>`,
            );
            spine.push(`<itemref idref="a${index}"/>`);
            navigation.push(
              `<li><a href="${filename}">${escapeXml(article.title)}</a></li>`,
            );
          }
          files.push({
            name: "OEBPS/nav.xhtml",
            data: Buffer.from(
              `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>${escapeXml(title)}</h1><ol>${navigation.join("")}</ol></nav></body></html>`,
            ),
          });
          files.push({
            name: "OEBPS/package.opf",
            data: Buffer.from(
              `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(settings.ebookLanguage)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${ebookId}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${escapeXml(settings.ebookLanguage)}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
            ),
          });
          const bytes = await makeZip(files);
          await this.store.writeTransaction(db, async (put) => {
            const key = await put(bytes);
            await db`UPDATE ebooks SET file_key=${key},error=null WHERE id=${ebookId}`;
          });
          if (send) {
            if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
              throw new ApiFailure(
                503,
                "SMTP_UNCONFIGURED",
                "Configure SMTP_HOST and SMTP_FROM on the server before sending ebooks",
              );
            if (!settings.ebookEmail)
              throw new ApiFailure(
                400,
                "EMAIL_REQUIRED",
                "Set an ebook destination email in settings",
              );
            // Durable pessimistic status: a crash after SMTP acceptance must never trigger a duplicate auto-send.
            await db`UPDATE ebooks SET delivery_state='sending',error='Delivery interrupted or outcome unknown; inspect SMTP logs before retrying' WHERE id=${ebookId}`;
            delivering = true;
            const transport = nodemailer.createTransport({
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT || 587),
              secure: process.env.SMTP_SECURE === "true",
              auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
              connectionTimeout: 10000,
              socketTimeout: 20000,
              greetingTimeout: 10000,
              disableFileAccess: true,
              disableUrlAccess: true,
            });
            try {
              const result = await transport.sendMail({
                from: process.env.SMTP_FROM,
                to: settings.ebookEmail,
                subject: title,
                text: "Your FeedInk reading archive is attached.",
                attachments: [
                  {
                    filename: "feedink.epub",
                    content: bytes,
                    contentType: "application/epub+zip",
                  },
                ],
              });
              if (!result.accepted?.length)
                throw new ApiFailure(
                  502,
                  "SMTP_REJECTED",
                  "SMTP did not accept the ebook recipient",
                );
            } finally {
              transport.close();
            }
            await db`UPDATE ebooks SET sent_at=now(),delivery_state='sent',error=null WHERE id=${ebookId}`;
          }
        } catch (e) {
          const message =
            e instanceof ApiFailure
              ? safeError(e)
              : delivering
                ? "SMTP delivery failed or its outcome is unknown; inspect operator SMTP logs before retrying"
                : "Ebook generation failed; verify the archive volume and try again";
          await db`UPDATE ebooks SET error=${message},delivery_state=CASE WHEN delivery_state='sending' THEN 'unknown' ELSE delivery_state END WHERE id=${ebookId}`;
          if (!scheduleKey)
            throw e instanceof ApiFailure
              ? e
              : new ApiFailure(
                  502,
                  "EBOOK_FAILED",
                  "Ebook generation or SMTP delivery failed; see ebook status",
                );
        }
        const [row] = await db`SELECT * FROM ebooks WHERE id=${ebookId}`;
        return ebookDto(row);
      },
      connection,
    );
  }
  async schedules(now = new Date(), connection?: SQL) {
    return withConnection(
      this.db,
      async (db) => {
        const users =
          await db`SELECT * FROM users WHERE NOT disabled AND NOT is_demo AND settings->>'ebookAutoSend'='true' LIMIT 1000`;
        for (const user of users) {
          const [lock] =
            await db`SELECT pg_try_advisory_lock(hashtextextended(${user.id},3)) AS locked`;
          if (!lock.locked) continue;
          try {
            const settings = settingsFor(user),
              day = Math.floor(now.getTime() / 86400000);
            if (now.getUTCHours() < settings.ebookHour) continue;
            const key = `v1:${settings.ebookIntervalDays}:${Math.floor(day / settings.ebookIntervalDays)}`;
            if (
              (
                await db`SELECT id FROM ebooks WHERE user_id=${user.id} AND schedule_key=${key}`
              ).length
            )
              continue;
            const articles =
              await db`SELECT a.id FROM articles a JOIN subscriptions s ON s.feed_id=a.feed_id AND s.user_id=a.user_id WHERE a.user_id=${user.id}
            AND (NOT EXISTS(SELECT 1 FROM folders f WHERE f.user_id=${user.id} AND lower(trim(f.name))='ebook') OR s.folder_id IN(SELECT id FROM folders f WHERE f.user_id=${user.id} AND lower(trim(f.name))='ebook'))
            AND NOT EXISTS(SELECT 1 FROM ebook_articles ea JOIN ebooks e ON e.id=ea.ebook_id WHERE ea.article_id=a.id AND e.schedule_key IS NOT NULL AND e.delivery_state IN ('sending','unknown','sent')) ORDER BY a.published_at,a.id LIMIT ${settings.ebookMaxArticles}`;
            if (articles.length < settings.ebookMinArticles) continue;
            await this.create(
              user,
              articles.map((a) => a.id),
              `FeedInk ${now.toISOString().slice(0, 10)}`,
              true,
              key,
              db,
            );
          } finally {
            await db`SELECT pg_advisory_unlock(hashtextextended(${user.id},3))`;
          }
        }
      },
      connection,
    );
  }
}
