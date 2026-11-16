import postgres from "postgres";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBackend, durableDirectory, syncDirectory } from "./backend.js";
import { storageConfigFromEnv } from "./config.js";
import { Store } from "./store.js";
import { databaseFingerprint, referencedKeys } from "./inventory.js";
import { migrateStorage, readJson, verifyReferenced } from "./copy.js";
import { packReferenced, referencedManifest, unpackReferenced, validateReferencedManifest } from "./bundle.js";
import { opendir, rmdir } from "node:fs/promises";

async function inputJson() {
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    if (bytes.length + chunk.length > 8192) throw new Error("Manifest exceeds limit");
    bytes = Buffer.concat([bytes, chunk]);
  }
  return JSON.parse(bytes.toString("utf8"));
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") {
    process.stdout.write(JSON.stringify(referencedManifest(args[0], args[1], args[2])) + "\n"); return;
  }
  if (command === "verify-manifest") {
    process.stdout.write(validateReferencedManifest(await inputJson()) + "\n"); return;
  }
  if (command === "check") {
    const result = await unpackReferenced(process.stdin, args[0]);
    process.stdout.write(result.fingerprint + "\n"); return;
  }
  if (command === "require-filesystem") {
    if (storageConfigFromEnv()?.backend === "s3") throw new Error("Legacy volume bundles require filesystem storage; use referenced-blob backup for S3");
    return;
  }
  if (process.env.STORAGE_MAINTENANCE !== "stopped") throw new Error("Explicit stopped-writer maintenance acknowledgement required");
  const directory = resolve(process.env.DATA_DIR || "/data");
  const backend = await createBackend(directory, storageConfigFromEnv());
  if (command === "empty") {
    await backend.init(); await backend.assertEmpty();
    // S3 restore also needs a fresh local journal/scratch volume.
    if (process.env.STORAGE_BACKEND === "s3") {
      await durableDirectory(directory, directory);
      for await (const _entry of await opendir(directory)) throw new Error("Restore requires an empty DATA_DIR");
    }
    return;
  }
  if (command === "unpack") {
    await backend.init();
    if (process.env.STORAGE_BACKEND === "s3") {
      for await (const _entry of await opendir(directory)) throw new Error("Restore requires an empty DATA_DIR");
    }
    const scratch = join(directory, ".storage-restore");
    const result = await unpackReferenced(process.stdin, args[0], { backend, scratch });
    await rmdir(scratch); await syncDirectory(directory);
    process.stdout.write(result.fingerprint + "\n"); return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    const sql = await db.reserve();
    try {
      await sql`SELECT pg_advisory_lock(71244004)`;
      if (command === "fingerprint") process.stdout.write(await databaseFingerprint(sql) + "\n");
      else if (command === "pack") {
        if (!args[0] || await databaseFingerprint(sql) !== args[0]) throw new Error("Database fingerprint changed before backup");
        await packReferenced(backend, referencedKeys(sql), args[0], process.stdout);
        if (await databaseFingerprint(sql) !== args[0]) throw new Error("Database changed during backup");
      } else if (command === "verify") {
        const fingerprint = await databaseFingerprint(sql), objects = await verifyReferenced(sql, backend);
        if (await databaseFingerprint(sql) !== fingerprint) throw new Error("Database changed during verification");
        process.stdout.write(JSON.stringify({ fingerprint, ...objects }) + "\n");
      } else if (command === "copy") {
        if (!args[0] || !process.env.TARGET_DATA_DIR) throw new Error("copy requires checkpoint path and TARGET_DATA_DIR");
        const targetDirectory = resolve(process.env.TARGET_DATA_DIR);
        const target = await createBackend(targetDirectory, storageConfigFromEnv(process.env, "TARGET_STORAGE_"));
        await target.init();
        const result = await migrateStorage(sql, backend, target, join(targetDirectory, ".storage-copy"), resolve(args[0]));
        process.stdout.write(JSON.stringify(result) + "\n");
      } else if (command === "recover" || command === "recover-legacy") {
        const store = new Store(directory, storageConfigFromEnv()); await store.init();
        if (command === "recover-legacy") await store.recoverLegacy(sql);
        else { while ((await store.recover(sql)).remainingPossible) { /* bounded journal passes */ } }
      } else if (command === "check-checkpoint") {
        const checkpoint = await readJson(args[0]);
        if (!checkpoint.complete || checkpoint.fingerprint !== await databaseFingerprint(sql)) throw new Error("Incomplete or stale checkpoint");
        process.stdout.write("Checkpoint complete; run verify against the selected destination before cutover.\n");
      } else throw new Error("Unknown storage command");
    } finally {
      try { await sql`SELECT pg_advisory_unlock(71244004)`; } finally { sql.release(); }
    }
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // SDK/DB errors can include credentials, endpoint names and SQL row contents; never print them.
    console.error("Storage operation failed. Keep writers stopped and preserve source, checkpoint and incomplete target; inspect configuration, integrity and capacity privately.");
    process.exitCode = 1;
  });
}
