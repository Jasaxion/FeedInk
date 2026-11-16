// Invoked only by storage-process.test.ts on the parent's approved hosted service gate.
import postgres from "postgres";
import { readdir } from "node:fs/promises";
import { Store, hash, type SQL } from "../src/core.js";

async function main() {
  if (!process.send || !process.env.TEST_STORAGE_DATABASE_URL) throw new Error("Hosted fixture IPC/database required");
  const [command, phase, directory, owner, article, image] = process.argv.slice(2);
  const bytes = Buffer.from(`synthetic writer ${phase}`), key = hash(bytes), store = new Store(directory);
  await store.init();
  const db = postgres(process.env.TEST_STORAGE_DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    const sql = await db.reserve();
    try {
      if (command === "recover") {
        await store.recover(sql);
        const [row] = await sql`SELECT EXISTS(SELECT 1 FROM images WHERE id=${image} AND file_key=${key}) AS present`;
        process.send({ type: "recovered", present: row.present, key: hash(await store.get(key)), journals: (await readdir(store.stagingDirectory)).length });
        return;
      }
      const writer = (async (strings: TemplateStringsArray, ...values: any[]) => {
        if (strings.join("") === "COMMIT") {
          if (phase === "after") await sql(strings, ...values);
          // Store reached COMMIT only after actual stage/publish/fsync/verification. The parent
          // kills this process at the barrier; this is not a thrown-error acknowledgement simulation.
          process.send!({ type: "barrier", phase, key, journals: (await readdir(store.stagingDirectory)).length });
          await new Promise<void>(() => {});
        }
        return sql(strings, ...values);
      }) as unknown as SQL;
      await store.writeTransaction(writer, async put => {
        await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${article},${owner},${article},'Synthetic',now(),'Writer witness','https://example.invalid/writer','<p>Writer witness</p>','Writer witness',${hash('<p>Writer witness</p>')})`;
        await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_type,content_hash) VALUES(${image},${article},'https://example.invalid/writer-image','cached',${await put(bytes)},'image/png',${key})`;
      });
    } finally { sql.release(); }
  } finally { await db.end(); }
}
main().catch(() => { process.send?.({ type: "failure" }); process.exitCode = 1; });
