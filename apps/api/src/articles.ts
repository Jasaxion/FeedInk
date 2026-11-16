import type {
  ArticleDetail,
  ArticleSummary,
  ArticlePage,
  ArticleQuery,
  ArticleStatePatch,
  Tag,
} from "@feedink/shared";
import { type DB, type SQL, type Row, iso, ApiFailure } from "./core.js";
import { articleQuery, uuid } from "./validation.js";
import { commonArticleTotal, countSnapshot, requireArticleCounts } from "./scale-counts.js";

// Used by lists and state acknowledgements, never transfer discarded body/TOAST columns.
const summaryColumns = (sql: SQL) => sql`a.id,a.user_id,a.feed_id,a.feed_title,a.title,a.url,a.author,a.published_at,a.summary,a.read,a.state_version,a.saved,a.word_count,a.archived_at,a.progress,a.enclosures`;

export class Articles {
  constructor(readonly db: DB) {}
  async owned(userId: string, articleId: string, sql: SQL = this.db): Promise<Row> {
    const [row] = await sql`SELECT * FROM articles WHERE id=${articleId} AND user_id=${userId}`;
    if (!row) throw new ApiFailure(404, "NOT_FOUND", "Article not found");
    return row;
  }
  async tags(userId: string): Promise<Tag[]> {
    return countSnapshot(this.db, userId, async (sql) => {
      const rows = await sql`SELECT t.id,t.name,t.color,COALESCE(c.total,0)::integer AS count FROM tags t LEFT JOIN article_counts c ON c.user_id=t.user_id AND c.tag_key=t.id::text AND c.feed_key='*' WHERE t.user_id=${userId} ORDER BY t.name`;
      return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, count: r.count }));
    });
  }
  async summaries(
    rows: Row[],
    sql: SQL = this.db,
  ): Promise<(ArticleSummary & { stateVersion: number })[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const tags = await sql`SELECT at.article_id,t.id,t.name,t.color,COALESCE(c.total,0)::integer AS count FROM article_tags at JOIN articles a ON a.id=at.article_id JOIN tags t ON t.id=at.tag_id AND t.user_id=a.user_id LEFT JOIN article_counts c ON c.user_id=t.user_id AND c.tag_key=t.id::text AND c.feed_key='*' WHERE at.article_id IN ${sql(ids)}`;
    const images = await sql`SELECT DISTINCT ON (article_id) article_id,id FROM images WHERE article_id IN ${sql(ids)} AND status='cached' ORDER BY article_id,captured_at,id`;
    const subscriptions = await sql`SELECT DISTINCT s.id,s.feed_id,s.title FROM subscriptions s JOIN articles a ON a.feed_id=s.feed_id AND a.user_id=s.user_id WHERE a.id IN ${sql(ids)}`;
    const byFeed = new Map(subscriptions.map((s) => [s.feed_id, s]));
    const byImage = new Map(images.map((i) => [i.article_id, i.id]));
    const byTags = new Map<string, Tag[]>();
    for (const t of tags) {
      const list = byTags.get(t.article_id) || [];
      list.push({ id: t.id, name: t.name, color: t.color, count: t.count });
      byTags.set(t.article_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      subscriptionId: byFeed.get(r.feed_id)?.id || null,
      feedTitle: byFeed.get(r.feed_id)?.title || r.feed_title,
      title: r.title,
      url: r.url,
      author: r.author,
      publishedAt: iso(r.published_at),
      summary: r.summary,
      thumbnailUrl: byImage.has(r.id) ? `/api/assets/${byImage.get(r.id)}` : null,
      read: r.read,
      stateVersion: r.state_version,
      saved: r.saved,
      tags: byTags.get(r.id) || [],
      wordCount: r.word_count,
      archivedAt: iso(r.archived_at),
      progress: r.progress,
      enclosures: r.enclosures,
    }));
  }
  async detail(
    userId: string,
    articleId: string,
  ): Promise<ArticleDetail & { stateVersion: number }> {
    return countSnapshot(this.db, userId, async (sql) => {
      const row = await this.owned(userId, articleId, sql),
        [summary] = await this.summaries([row], sql);
      const images = await sql`SELECT * FROM images WHERE article_id=${articleId} ORDER BY id`;
      return {
        ...summary,
        contentHtml: row.content_html,
        fulltextHtml: row.fulltext_html,
        contentText: row.content_text,
        fetchedAt: iso(row.fetched_at),
        contentHash: row.content_hash,
        fulltextError: row.fulltext_error,
        images: images.map((i) => ({
          id: i.id, originalUrl: i.original_url, url: `/api/assets/${i.id}`,
          status: i.status, contentType: i.content_type,
        })),
      };
    });
  }
  selection(userId: string, input: ArticleQuery, withCursor = true, db: SQL = this.db) {
    const q = articleQuery.parse(input);
    let condition = db`a.user_id=${userId}`;
    if (q.scope === "all" || q.scope === "unread")
      condition = db`${condition} AND (a.feed_id IS NULL OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.feed_id=a.feed_id AND s.user_id=${userId}))`;
    if (q.scope === "unread") condition = db`${condition} AND NOT a.read`;
    if (q.scope === "saved") condition = db`${condition} AND a.saved`;
    if (q.subscriptionId)
      condition = db`${condition} AND a.feed_id IN(SELECT feed_id FROM subscriptions WHERE id=${q.subscriptionId} AND user_id=${userId})`;
    if (q.folderId)
      condition = db`${condition} AND a.feed_id IN(SELECT feed_id FROM subscriptions WHERE folder_id=${q.folderId} AND user_id=${userId})`;
    if (q.tagId)
      condition = db`${condition} AND EXISTS(SELECT 1 FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id AND t.id=${q.tagId} AND t.user_id=${userId})`;
    if (q.before)
      condition = db`${condition} AND a.published_at<${q.before}::text::timestamptz`;
    if (q.after)
      condition = db`${condition} AND a.published_at>${q.after}::text::timestamptz`;
    if (q.q) {
      const pattern = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      condition = db`${condition} AND (to_tsvector('simple',a.title || ' ' || a.content_text) @@ plainto_tsquery('simple',${q.q}) OR a.title ILIKE ${pattern} OR a.content_text ILIKE ${pattern})`;
    }
    if (withCursor && q.cursor) {
      let value: { date: string; id: string };
      try {
        const raw = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
        if (
          typeof raw.date !== "string" ||
          !Number.isFinite(Date.parse(raw.date)) ||
          !uuid.safeParse(raw.id).success
        )
          throw new Error();
        value = raw;
      } catch {
        throw new ApiFailure(
          400,
          "INVALID_CURSOR",
          "The article cursor is invalid",
        );
      }
      // Bind text before the timestamp cast: postgres.js timestamp serialization
      // otherwise rounds PostgreSQL microseconds through a JavaScript Date.
      condition =
        q.sort === "oldest"
          ? db`${condition} AND (a.published_at,a.id)>(${value.date}::text::timestamptz,${value.id}::uuid)`
          : db`${condition} AND (a.published_at,a.id)<(${value.date}::text::timestamptz,${value.id}::uuid)`;
    }
    return { condition, q };
  }
  async page(userId: string, input: ArticleQuery): Promise<ArticlePage> {
    return countSnapshot(this.db, userId, async (sql) => {
      const { condition, q } = this.selection(userId, input, true, sql);
      let total = await commonArticleTotal(sql, userId, q);
      if (total === undefined) {
        const countCondition = this.selection(userId, input, false, sql).condition;
        const [count] = await sql`SELECT count(*)::integer AS total FROM articles a WHERE ${countCondition}`;
        total = count.total;
      }
      const order = q.sort === "oldest" ? sql`a.published_at,a.id` : sql`a.published_at DESC,a.id DESC`;
      const rows = await sql`SELECT ${summaryColumns(sql)},to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date FROM articles a WHERE ${condition} ORDER BY ${order} LIMIT ${q.limit + 1}`;
      const visible = rows.slice(0, q.limit), last = visible.at(-1);
      return {
        items: await this.summaries(visible, sql),
        total: total!,
        nextCursor: rows.length > q.limit && last
          ? Buffer.from(JSON.stringify({ date: last.cursor_date, id: last.id })).toString("base64url")
          : null,
      };
    });
  }
  async patch(
    userId: string,
    articleId: string,
    patch: ArticleStatePatch,
    expectedVersion?: number,
  ) {
    return this.db.begin(async (tx) => {
      await requireArticleCounts(tx, userId);
      // Count-changing API writers take the owner aggregate before article rows.
      // This avoids a bulk writer holding it while a single writer holds a later
      // article row and waits for the same aggregate. Progress-only stays exempt.
      if (patch.read !== undefined || patch.saved !== undefined || patch.tagIds !== undefined)
        await tx`SELECT total FROM article_counts WHERE user_id=${userId} AND tag_key='' AND feed_key='*' FOR UPDATE`;
      const [row] =
        await tx`SELECT state_version FROM articles WHERE id=${articleId} AND user_id=${userId} FOR UPDATE`;
      if (!row) throw new ApiFailure(404, "NOT_FOUND", "Article not found");
      if (
        expectedVersion !== undefined &&
        row.state_version !== expectedVersion
      )
        throw new ApiFailure(
          412,
          "STATE_CONFLICT",
          "Article state changed; reload before retrying",
        );
      if (patch.tagIds) {
        const unique = [...new Set(patch.tagIds)];
        if (unique.length) {
          const found =
            await tx`SELECT id FROM tags WHERE user_id=${userId} AND id IN ${tx(unique)}`;
          if (found.length !== unique.length)
            throw new ApiFailure(
              404,
              "NOT_FOUND",
              "One or more tags were not found",
            );
        }
        await tx`DELETE FROM article_tags WHERE article_id=${articleId}`;
        for (const tagId of unique)
          await tx`INSERT INTO article_tags(article_id,tag_id) VALUES(${articleId},${tagId})`;
      }
      const updated =
        await tx`UPDATE articles a SET state_version=state_version+1,read=COALESCE(${patch.read ?? null},read),saved=COALESCE(${patch.saved ?? null},saved),progress=COALESCE(${patch.progress ?? null},progress) WHERE id=${articleId} AND user_id=${userId} RETURNING ${summaryColumns(tx)}`;
      return (await this.summaries(updated, tx))[0];
    });
  }
  async bulk(
    userId: string,
    read: boolean,
    ids?: string[],
    query?: ArticleQuery,
  ) {
    if (ids && !ids.length) return { updated: 0 };
    return this.db.begin(async (tx) => {
      await tx`SELECT total FROM article_counts WHERE user_id=${userId} AND tag_key='' AND feed_key='*' FOR UPDATE`;
      const condition = ids
        ? tx`a.user_id=${userId} AND a.id IN ${tx(ids)}`
        : this.selection(userId, query || {}, true, tx).condition;
      const rows = await tx`UPDATE articles a SET state_version=state_version+1,read=${read} WHERE ${condition}`;
      return { updated: rows.count };
    });
  }
}
