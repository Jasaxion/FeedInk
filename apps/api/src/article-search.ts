import type postgres from 'postgres';
import type { SQL } from './core.js';

export function articleLiteralSearch(sql: SQL, query: string, fields: {
  title: postgres.Fragment; content: postgres.Fragment; url?: postgres.Fragment;
}) {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  // Only printable ASCII nonletters: case conversion neither changes these
  // characters nor introduces them from letters. Keep ILIKE for ALL letters
  // (including ASCII) and non-ASCII queries; do not use JS locale case folding.
  const caseless = /^[\x20-\x40\x5b-\x60\x7b-\x7e]+$/.test(query);
  const literal = (text: postgres.Fragment) => caseless
    ? sql`${text} LIKE ${pattern}` : sql`${text} ILIKE ${pattern}`;
  let match = literal(fields.title);
  if (fields.url) match = sql`${match} OR ${literal(fields.url)}`;
  // ICU can lowercase a truncated suffix differently (e.g. final sigma).
  // This uncorrelated catalog guard is evaluated once per statement and follows
  // the actual column/default collation, never a stale application-side cache.
  const contextFreeCase = sql`(SELECT c.collisdeterministic AND
    (CASE WHEN c.collprovider='d' THEN d.datlocprovider ELSE c.collprovider END)='c'
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_collation c ON c.oid=a.attcollation
    JOIN pg_catalog.pg_database d ON d.datname=current_database()
    WHERE a.attrelid='articles'::regclass AND a.attname='content_text' AND NOT a.attisdropped)`;
  const prefix = literal(sql`left(${fields.content},256)`);
  // Caseless LIKE is a true substring witness. ILIKE needs context-free casing.
  // Keep the indexed constant and complete fallback, including boundary matches.
  const safePrefix = caseless ? prefix : sql`(${contextFreeCase} AND ${prefix})`;
  return sql`(${match} OR ${safePrefix} OR ${literal(fields.content)})`;
}
