import type { ArticleQuery } from "@feedink/shared";
import { ApiFailure, type DB, type SQL } from "./core.js";

// Global blob lock (when needed) -> owner coordination -> metadata/article/tag
// locks -> trigger counters. Call only inside the transaction doing the writes;
// never retain this lock while subsequently entering Store.writeTransaction.
export async function coordinateArticleWrites(sql: SQL, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::uuid::text,71244005))`;
}

export async function articleWrite<T>(db: DB, userId: string, task: (sql: SQL) => Promise<T>): Promise<T> {
  return db.begin(async (sql) => {
    await coordinateArticleWrites(sql, userId);
    return task(sql);
  }) as Promise<T>;
}

export async function requireArticleCounts(sql: SQL, userId: string) {
  const [state] = await sql`SELECT valid FROM article_count_state WHERE user_id=${userId}`;
  if (!state?.valid)
    throw new ApiFailure(503, "COUNTS_UNAVAILABLE", "Article counts require operator reconciliation");
}

// Counters, metadata, selection and hydration must share one MVCC snapshot.
export async function countSnapshot<T>(db: DB, userId: string, task: (sql: SQL) => Promise<T>): Promise<T> {
  return db.begin("isolation level repeatable read read only", async (sql) => {
    await requireArticleCounts(sql, userId);
    return task(sql);
  }) as Promise<T>;
}

// Only no-search/no-date shapes use counters. Cursor never changes the total.
// Metadata joins are proportional to feeds/tags, not article history. Keeping
// subscription eligibility here avoids stale deltas during subscribe/unsubscribe.
export async function commonArticleTotal(sql: SQL, userId: string, q: ArticleQuery): Promise<number | undefined> {
  if (q.q || q.before || q.after) return undefined;
  let condition = sql`c.user_id=${userId} AND c.tag_key=${(q.tagId || "").toLowerCase()}`;
  const scope = q.scope || "all";
  const subscribed = scope === "all" || scope === "unread";
  if (!subscribed && !q.subscriptionId && !q.folderId) {
    condition = sql`${condition} AND c.feed_key='*'`;
  } else {
    condition = sql`${condition} AND c.feed_key<>'*'`;
    if (subscribed)
      condition = sql`${condition} AND (c.feed_key='' OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=${userId} AND s.feed_id::text=c.feed_key))`;
    if (q.subscriptionId)
      condition = sql`${condition} AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=${userId} AND s.id=${q.subscriptionId} AND s.feed_id::text=c.feed_key)`;
    if (q.folderId)
      condition = sql`${condition} AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=${userId} AND s.folder_id=${q.folderId} AND s.feed_id::text=c.feed_key)`;
  }
  const column = scope === "unread" ? sql`c.unread` : scope === "saved" ? sql`c.saved` : sql`c.total`;
  const [{ total }] = await sql`SELECT COALESCE(sum(${column}),0)::integer AS total FROM article_counts c WHERE ${condition}`;
  return total;
}
