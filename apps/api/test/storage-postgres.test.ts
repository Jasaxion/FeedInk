import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../src/app.js";
import { Auth } from "../src/auth.js";
import { hash, id, type Config, type SQL } from "../src/core.js";
import { storageConfigFromEnv } from "../src/storage/config.js";
import { createBackend, syncDirectory } from "../src/storage/backend.js";
import { databaseFingerprint, referencedKeys } from "../src/storage/inventory.js";
import { FilesystemBackend } from "../src/storage/filesystem.js";
import { migrateStorage, verifyReferenced } from "../src/storage/copy.js";

for (const mode of ["filesystem", "s3"] as const) {
  test(`storage ${mode}: owner-gated shared bytes, real unknown commit, checkpoint/fingerprint preservation`, {
    skip: !process.env.TEST_STORAGE_DATABASE_URL || (mode === "s3" && process.env.TEST_STORAGE_BACKEND !== "s3"), timeout: 600000,
  }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "feedink-storage-pg-")), dataDir = join(directory, "source");
    await mkdir(dataDir); await syncDirectory(directory);
    const storage = mode === "s3" ? storageConfigFromEnv(process.env, "TEST_STORAGE_") : undefined;
    if (storage?.backend === "s3") storage.prefix = (storage.prefix || "") + `fixture-${id()}/`;
    const config: Config = { databaseUrl: process.env.TEST_STORAGE_DATABASE_URL!, dataDir, storage,
      appUrl: "http://localhost:3000", sessionSecret: "synthetic-storage-session-secret-32-characters", host: "127.0.0.1", port: 0,
      registration: true, fetchAllowHosts: [], webDir: join(directory, "no-web"), worker: false };
    const db = postgres(config.databaseUrl, { max: 4 }), ctx = await createApp(config, db), owners: string[] = [];
    try {
      assert.equal(ctx.store.config.backend, mode, "app integration must pass config.storage to Store");
      const account = async () => {
        const userId = id(), token = randomBytes(32).toString("base64url"); owners.push(userId);
        await db`INSERT INTO users(id,email,name,password_hash) VALUES(${userId},${`storage-${userId}@example.invalid`},'Synthetic storage','disabled')`;
        await db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${userId},now()+interval '1 hour')`;
        return { id: userId, headers: { cookie: `feedink_session=${token}`, "x-csrf-token": new Auth(db, config).csrf(token) } };
      };
      const a = await account(), b = await account(), bytes = Buffer.from([0, 255, 42, 10, 13]), key = hash(bytes), images: string[] = [], articleIds: string[] = [];
      const sql = await db.reserve();
      try {
        for (const owner of [a, b]) {
          const articleId = id(), imageId = id(); images.push(imageId); articleIds.push(articleId);
          await ctx.store.writeTransaction(sql, async put => {
            assert.equal(await put(bytes), key);
            await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${articleId},${owner.id},${articleId},'Synthetic',now(),'Original body','https://example.invalid/original','<p>Preserved body</p>','Preserved body',${hash('<p>Preserved body</p>')})`;
            await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_type,content_hash) VALUES(${imageId},${articleId},'https://example.invalid/image','cached',${key},'image/png',${key})`;
            await sql`INSERT INTO annotation_contexts(user_id,article_id,mode,content_hash,source_url,title,content_html) VALUES(${owner.id},${articleId},'feed',${hash('retained-only')},'https://example.invalid/old','Old retained-only title','<p>Offline draft anchor</p>')`;
          });
        }
        for (let index = 0; index < 2; index++) {
          const owner = index ? b : a, other = index ? a : b;
          const owned = await ctx.app.inject({ method: "GET", url: `/api/assets/${images[index]}`, headers: owner.headers });
          assert.equal(owned.statusCode, 200); assert.deepEqual(owned.rawPayload, bytes);
          assert.equal((await ctx.app.inject({ method: "GET", url: `/api/assets/${images[index]}`, headers: other.headers })).statusCode, 404);
          assert.equal((await ctx.app.inject({ method: "GET", url: `/api/assets/${images[index]}` })).statusCode, 401);
        }
        const ambiguous = (async (strings: TemplateStringsArray, ...values: any[]) => {
          const result = await sql(strings, ...values);
          if (strings.join("") === "COMMIT") throw new Error("synthetic lost COMMIT response");
          return result;
        }) as unknown as SQL;
        await assert.rejects(ctx.store.writeTransaction(ambiguous, put => put(bytes)), /lost COMMIT/);
        assert.equal((await readdir(ctx.store.stagingDirectory)).length, 1);
        await ctx.store.recover(sql);
        assert.deepEqual(await readdir(ctx.store.stagingDirectory), []);
        assert.deepEqual(await ctx.store.get(key), bytes);
        const probe = await db.reserve();
        try {
          const [{ acquired }] = await probe`SELECT pg_try_advisory_lock(71244004) AS acquired`;
          assert.equal(acquired, true);
        } finally { await probe`SELECT pg_advisory_unlock(71244004)`; probe.release(); }

        // 271 distinct bytes, not just 271 references to a shared key. Every reference source
        // participates, including noncached image rows whose retained key must not be skipped.
        const expectedKeys = [key];
        await ctx.store.writeTransaction(sql, async put => {
          for (let index = 0; index < 270; index++) {
            const distinct = await put(Buffer.from(`distinct migration fixture ${index}`));
            expectedKeys.push(distinct);
            if (index % 3 === 0) {
              await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_hash,content_type) VALUES(${id()},${articleIds[0]},${`https://example.invalid/retained-${index}`},${index % 2 ? 'failed' : 'pending'},${distinct},${distinct},'image/png')`;
            } else if (index % 3 === 1) {
              await sql`INSERT INTO ebooks(id,user_id,title,article_count,file_key) VALUES(${id()},${a.id},'Retained ebook',1,${distinct})`;
            } else {
              await sql`INSERT INTO feeds(id,user_id,url,title,icon_file_key) VALUES(${id()},${a.id},${`https://example.invalid/icon-${index}`},'Retained icon',${distinct})`;
            }
          }
        });
        const inventory: string[] = [];
        for await (const referenced of referencedKeys(sql)) inventory.push(referenced);
        assert.deepEqual(inventory, expectedKeys.sort());
        assert.equal(new Set(inventory).size, 271);
        const source = await createBackend(dataDir, storage), targetDirectory = join(directory, "copied"), target = new FilesystemBackend(targetDirectory);
        await mkdir(targetDirectory); await syncDirectory(directory); await target.init();
        const checkpoint = join(directory, "checkpoint.json"), scratch = join(targetDirectory, ".copy");
        // This test DB must be dedicated to this fixture: every referenced blob must belong to its source backend.
        const before = await databaseFingerprint(sql);
        await sql`BEGIN`;
        try {
          await sql`UPDATE images SET file_key='' WHERE id=${images[0]}`;
          await assert.rejects(verifyReferenced(sql, source), /Empty referenced storage key/);
        } finally { await sql`ROLLBACK`; }
        const publish = target.publish.bind(target);
        let copiedBeforeInterruption = 0;
        target.publish = async (key, file) => {
          await publish(key, file);
          if (++copiedBeforeInterruption === 130) throw new Error('copy acknowledgement lost after 128-checkpoint');
        };
        await assert.rejects(migrateStorage(sql, source, target, scratch, checkpoint), /acknowledgement lost/);
        const partial = JSON.parse(await readFile(checkpoint, 'utf8'));
        assert.equal(partial.copied, 128); assert.equal(partial.lastKey, inventory[127]); assert.equal(partial.complete, false);
        target.publish = publish;
        const result = await migrateStorage(sql, source, target, scratch, checkpoint);
        assert.equal(result.count, 271, 'resume must cross the 256-key inventory boundary');
        assert.equal(result.fingerprint, before);
        assert.equal(await databaseFingerprint(sql), before);
        assert.deepEqual(await verifyReferenced(sql, target), await verifyReferenced(sql, source));
        const saved = JSON.parse(await readFile(checkpoint, "utf8")); assert.equal(saved.complete, true);
        assert.equal(saved.copied, 271); assert.equal(saved.lastKey, inventory[270]);
        // Simulate interruption before durable checkpoint: replaying a page is idempotent and source is retained.
        await writeFile(checkpoint, JSON.stringify({ ...saved, lastKey: "", copied: 0, complete: false }));
        await migrateStorage(sql, source, target, scratch, checkpoint);
        assert.deepEqual(await ctx.store.get(key), bytes);
        await sql`UPDATE annotation_contexts SET title='Changed retained-only context' WHERE user_id=${a.id}`;
        assert.notEqual(await databaseFingerprint(sql), before);
        await assert.rejects(migrateStorage(sql, source, target, scratch, checkpoint), /checkpoint deployment\/database mismatch/);
        await sql`UPDATE annotation_contexts SET title='Old retained-only title' WHERE user_id=${a.id}`;
        assert.equal(await databaseFingerprint(sql), before);
        if (storage?.backend === "s3") {
          const reverseDirectory = join(directory, "reverse"), reverse = await createBackend(reverseDirectory, { ...storage, prefix: storage.prefix + "reverse/" });
          await mkdir(reverseDirectory); await syncDirectory(directory); await reverse.init();
          const reversed = await migrateStorage(sql, target, reverse, join(reverseDirectory, ".copy"), join(directory, "reverse-checkpoint.json"));
          assert.equal(reversed.fingerprint, before);
          assert.deepEqual(await verifyReferenced(sql, reverse), await verifyReferenced(sql, source));
        }
        await writeFile(target.path(key), "corrupt");
        await assert.rejects(migrateStorage(sql, source, target, scratch, checkpoint), /integrity mismatch/);
      } finally { sql.release(); }
    } finally {
      for (const owner of owners) await db`DELETE FROM users WHERE id=${owner}`;
      await ctx.app.close(); await db.end(); await rm(directory, { recursive: true, force: true });
    }
  });
}
