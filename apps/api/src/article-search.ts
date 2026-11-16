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
  // 256 is a SQL constant, matching 011's expression index even in generic
  // plans. The prefix is ONLY an extra positive witness; never truncate the
  // fallback (which also finds matches crossing this boundary).
  return sql`(${match} OR ${literal(sql`left(${fields.content},256)`)} OR ${literal(fields.content)})`;
}
