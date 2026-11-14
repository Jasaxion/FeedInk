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

export class Articles {
  constructor(readonly db: DB) {}
  async owned(userId: string, articleId: string): Promise<Row> {
    const [row] = await this
      .db`SELECT * FROM articles WHERE id=${articleId} AND user_id=${userId}`;
    if (!row) throw new ApiFailure(404, "NOT_FOUND", "Article not found");
    return row;
  }
  async tags(userId: string): Promise<Tag[]> {
    const rows = await this
      .db`SELECT t.*,count(at.article_id)::integer AS count FROM tags t LEFT JOIN article_tags at ON at.tag_id=t.id WHERE t.user_id=${userId} GROUP BY t.id ORDER BY t.name`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      count: r.count,
    }));
  }
  async summaries(
    rows: Row[],
    sql: SQL = this.db,
  ): Promise<(ArticleSummary & { stateVersion: number })[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const tags =
      await sql`SELECT at.article_id,t.*,(SELECT count(*)::integer FROM article_tags WHERE tag_id=t.id) AS count FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id IN ${sql(ids)}`;
    const images =
      await sql`SELECT DISTINCT ON (article_id) article_id,id FROM images WHERE article_id IN ${sql(ids)} AND status='cached' ORDER BY article_id,captured_at,id`;
    const subscriptions =
      await sql`SELECT s.id,s.feed_id,s.title FROM subscriptions s WHERE s.feed_id IN (SELECT feed_id FROM articles WHERE id IN ${sql(ids)})`;
    return rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      subscriptionId:
        subscriptions.find((s) => s.feed_id === r.feed_id)?.id || null,
      feedTitle:
        subscriptions.find((s) => s.feed_id === r.feed_id)?.title ||
        r.feed_title,
      title: r.title,
      url: r.url,
      author: r.author,
      publishedAt: iso(r.published_at),
      summary: r.summary,
      thumbnailUrl: images.find((i) => i.article_id === r.id)
        ? `/api/assets/${images.find((i) => i.article_id === r.id)!.id}`
        : null,
      read: r.read,
      stateVersion: r.state_version,
      saved: r.saved,
      tags: tags
        .filter((t) => t.article_id === r.id)
        .map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          count: t.count,
        })),
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
    const row = await this.owned(userId, articleId),
      [summary] = await this.summaries([row]);
    const images = await this
      .db`SELECT * FROM images WHERE article_id=${articleId} ORDER BY id`;
    return {
      ...summary,
      contentHtml: row.content_html,
      fulltextHtml: row.fulltext_html,
      contentText: row.content_text,
      fetchedAt: iso(row.fetched_at),
      contentHash: row.content_hash,
      fulltextError: row.fulltext_error,
      images: images.map((i) => ({
        id: i.id,
        originalUrl: i.original_url,
        url: `/api/assets/${i.id}`,
        status: i.status,
        contentType: i.content_type,
      })),
    };
  }
  selection(userId: string, input: ArticleQuery, withCursor = true) {
    const q = articleQuery.parse(input),
      db = this.db;
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
    const { condition, q } = this.selection(userId, input),
      countCondition = this.selection(userId, input, false).condition;
    const [{ total }] = await this
      .db`SELECT count(*)::integer AS total FROM articles a WHERE ${countCondition}`;
    const rows =
      q.sort === "oldest"
        ? await this
            .db`SELECT a.*,to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date FROM articles a WHERE ${condition} ORDER BY a.published_at,a.id LIMIT ${q.limit + 1}`
        : await this
            .db`SELECT a.*,to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date FROM articles a WHERE ${condition} ORDER BY a.published_at DESC,a.id DESC LIMIT ${q.limit + 1}`;
    const hasMore = rows.length > q.limit,
      visible = rows.slice(0, q.limit),
      last = visible.at(-1);
    return {
      items: await this.summaries(visible),
      total,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ date: last.cursor_date, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  async patch(
    userId: string,
    articleId: string,
    patch: ArticleStatePatch,
    expectedVersion?: number,
  ) {
    return this.db.begin(async (tx) => {
      const [row] =
        await tx`SELECT * FROM articles WHERE id=${articleId} AND user_id=${userId} FOR UPDATE`;
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
        await tx`UPDATE articles SET state_version=state_version+1,read=COALESCE(${patch.read ?? null},read),saved=COALESCE(${patch.saved ?? null},saved),progress=COALESCE(${patch.progress ?? null},progress) WHERE id=${articleId} AND user_id=${userId} RETURNING *`;
      return (await this.summaries(updated, tx))[0];
    });
  }
  async bulk(
    userId: string,
    read: boolean,
    ids?: string[],
    query?: ArticleQuery,
  ) {
    if (ids) {
      if (!ids.length) return { updated: 0 };
      const rows = await this
        .db`UPDATE articles SET state_version=state_version+1,read=${read} WHERE user_id=${userId} AND id IN ${this.db(ids)} RETURNING id`;
      return { updated: rows.length };
    }
    const { condition } = this.selection(userId, query || {});
    const rows = await this
      .db`UPDATE articles a SET state_version=state_version+1,read=${read} WHERE ${condition} RETURNING id`;
    return { updated: rows.length };
  }
}
