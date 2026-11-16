import { createHash } from "node:crypto";
import type { SQL } from "../core.js";
import { storageKey } from "./backend.js";

/** Keyset pages bound JS memory; PostgreSQL reference indexes are required for large installations. */
export async function* referencedKeys(sql: SQL, after = "") {
  if (!after) {
    const [invalid] = await sql`SELECT EXISTS(SELECT 1 FROM images WHERE file_key='' UNION ALL SELECT 1 FROM ebooks WHERE file_key='' UNION ALL SELECT 1 FROM feeds WHERE icon_file_key='') AS found`;
    if (invalid.found) throw new Error("Empty referenced storage key");
  }
  let last = after;
  while (true) {
    const rows = await sql`SELECT file_key FROM (
      (SELECT file_key FROM images WHERE file_key > ${last} ORDER BY file_key LIMIT 256)
      UNION (SELECT file_key FROM ebooks WHERE file_key > ${last} ORDER BY file_key LIMIT 256)
      UNION (SELECT icon_file_key AS file_key FROM feeds WHERE icon_file_key > ${last} ORDER BY icon_file_key LIMIT 256)
    ) refs ORDER BY file_key LIMIT 256`;
    if (!rows.length) return;
    for (const row of rows) { last = storageKey(row.file_key); yield last; }
  }
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Hash every public table, in primary-key order, including retained-only contexts and auth/owner rows.
 * No private row contents are emitted. Run with every writer stopped, not as an online consistency claim. */
export async function databaseFingerprint(sql: SQL): Promise<string> {
  const hash = createHash("sha256");
  const add = (text: string) => { hash.update(`${Buffer.byteLength(text)}:`); hash.update(text); };
  await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  try {
    await sql`SET LOCAL TIME ZONE 'UTC'`;
    await sql`SET LOCAL extra_float_digits = 3`;
    const tables = await sql`SELECT c.relname AS name,
      ARRAY(SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
        WHERE i.indrelid=c.oid AND i.indisprimary ORDER BY k.position) AS keys
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname`;
    for (const table of tables) {
      if (!table.keys.length) throw new Error("Fingerprint requires primary keys on every public table");
      add(table.name);
      const columns = await sql`SELECT column_name,data_type,udt_name,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='public' AND table_name=${table.name} ORDER BY ordinal_position`;
      add(JSON.stringify(columns.map(row => ({ ...row }))));
      // Server-side cursor avoids retaining all rows (or all blob/owner names) in the process.
      const query = sql.unsafe(`SELECT to_jsonb(t)::text AS record FROM public.${quote(table.name)} t ORDER BY ${(table.keys as string[]).map(quote).join(",")}`);
      for await (const rows of query.cursor(32)) for (const row of rows) add(row.record);
    }
    await sql`COMMIT`;
    return hash.digest("hex");
  } catch (error) { await sql`ROLLBACK`; throw error; }
}
