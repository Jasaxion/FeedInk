import { createHash } from "node:crypto";
import { mkdtemp, open, opendir, readFile, rm, rmdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { SQL } from "../core.js";
import { createBackend, digest, durableDirectory, missing, storageKey, syncDirectory, type BlobBackend } from "./backend.js";
import { FilesystemBackend } from "./filesystem.js";
import { validateStorageConfig, type StorageConfig } from "./config.js";
import { privateBlobStream } from "./stream.js";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const DEFAULT_RECOVERY_ENTRIES = 256;

export class Store {
  readonly stagingDirectory: string;
  readonly config: StorageConfig;
  private backendPromise?: Promise<BlobBackend>;
  constructor(readonly directory: string, config?: StorageConfig) {
    this.config = validateStorageConfig(config);
    this.stagingDirectory = join(directory, ".storage-staging");
  }
  private backend() { return this.backendPromise ||= createBackend(this.directory, this.config); }
  async init() {
    await durableDirectory(this.stagingDirectory, this.directory);
    await (await this.backend()).init();
  }
  /** Filesystem destination path; reads also support legacy root/<key>. Not a public URL. */
  path(key: string) {
    if (this.config.backend !== "filesystem") throw new Error("S3 storage has no local blob path");
    return new FilesystemBackend(this.directory).path(key);
  }
  async size(key: string) { return (await this.backend()).size(storageKey(key)); }
  async stream(key: string): Promise<Readable> {
    storageKey(key);
    try { return privateBlobStream(await (await this.backend()).read(key)); }
    catch { throw new Error("Private blob read failed"); }
  }
  async get(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await (await this.backend()).read(storageKey(key))) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  async referenced(sql: SQL, key: string) {
    const [row] = await sql`SELECT EXISTS(SELECT 1 FROM images WHERE file_key=${key} UNION ALL SELECT 1 FROM ebooks WHERE file_key=${key} UNION ALL SELECT 1 FROM feeds WHERE icon_file_key=${key}) AS found`;
    return row.found as boolean;
  }
  private async intent(directory: string) {
    const file = await open(join(directory, "intent.json"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, backend: sha256((await this.backend()).identity()) }));
      await file.sync();
    } finally { await file.close(); }
    await syncDirectory(directory);
  }
  private async clearJournal(directory: string) {
    for await (const entry of await opendir(directory)) {
      if (entry.name === "intent.json") continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) throw new Error("Unexpected storage staging entry");
      await rm(join(directory, entry.name));
    }
    await syncDirectory(directory);
    // Keep the intent until all staged keys are gone, including on a partial cleanup failure.
    await rm(join(directory, "intent.json"), { force: true });
    await syncDirectory(directory);
    await rmdir(directory);
    await syncDirectory(this.stagingDirectory);
  }
  private async checkIntent(directory: string) {
    const info = await lstat(join(directory, "intent.json"));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error("Invalid storage intent");
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    if (intent.version !== 1 || intent.backend !== sha256((await this.backend()).identity()))
      throw new Error("Storage intent backend mismatch; recover with original deployment configuration before cutover");
  }
  private async recoverDirectory(sql: SQL, directory: string, budget: number, legacy: boolean) {
    if (!legacy) {
      try { await this.checkIntent(directory); } catch (error) {
        if (!missing(error)) throw error;
        // Crash before the intent became durable: BEGIN/publish have not happened.
        const entries = await opendir(directory);
        for await (const _entry of entries) throw new Error("Incomplete storage intent requires operator inspection");
        await rmdir(directory);
        await syncDirectory(this.stagingDirectory);
        return { processed: 1, complete: true };
      }
    }
    let processed = 0, complete = true;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.name === "intent.json" && !legacy) continue;
      if (processed >= budget) { complete = false; break; }
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) throw new Error("Unexpected storage staging entry");
      const key = entry.name;
      if (await this.referenced(sql, key)) {
        const backend = await this.backend();
        // Re-publishing uses the same immutable key and verifies collisions. No delete, even on uncertainty.
        const staged = await digest((await open(join(directory, key), "r")).createReadStream());
        if (staged.key !== key) throw new Error("Storage staging integrity mismatch");
        await backend.publish(key, join(directory, key));
      }
      await rm(join(directory, key));
      await syncDirectory(directory);
      processed++;
    }
    if (complete) {
      if (!legacy) await rm(join(directory, "intent.json"));
      await rmdir(directory);
      await syncDirectory(legacy ? this.directory : this.stagingDirectory);
    }
    return { processed: Math.max(processed, 1), complete };
  }
  /** Only the dedicated journal is enumerated, with a fixed entry budget. Finals are never enumerated/deleted. */
  async recover(sql: SQL, budget = DEFAULT_RECOVERY_ENTRIES) {
    if (!Number.isInteger(budget) || budget < 1 || budget > 10_000) throw new Error("Invalid recovery budget");
    await sql`SELECT pg_advisory_lock(71244004)`;
    let processed = 0, remainingPossible = false;
    try {
      await durableDirectory(this.stagingDirectory, this.directory);
      for await (const entry of await opendir(this.stagingDirectory)) {
        if (processed >= budget) { remainingPossible = true; break; }
        if (!entry.isDirectory() || !/^txn-[A-Za-z0-9]+$/.test(entry.name)) throw new Error("Unexpected storage journal entry");
        const result = await this.recoverDirectory(sql, join(this.stagingDirectory, entry.name), budget - processed, false);
        processed += result.processed;
        if (!result.complete) { remainingPossible = true; break; }
      }
      return { processed, remainingPossible };
    } finally { await sql`SELECT pg_advisory_unlock(71244004)`; }
  }
  /** Maintenance only: streaming discovery of old root .stage-* directories, never startup root scans. */
  async recoverLegacy(sql: SQL) {
    if (this.config.backend !== "filesystem") throw new Error("Recover legacy staging on the original filesystem before S3 cutover");
    await sql`SELECT pg_advisory_lock(71244004)`;
    try {
      for await (const entry of await opendir(this.directory)) {
        if (entry.isDirectory() && /^\.stage-[A-Za-z0-9]+$/.test(entry.name)) {
          let result;
          do { result = await this.recoverDirectory(sql, join(this.directory, entry.name), 256, true); } while (!result.complete);
        }
      }
    } finally { await sql`SELECT pg_advisory_unlock(71244004)`; }
  }
  async writeTransaction<T>(sql: SQL, task: (put: (data: Buffer) => Promise<string>) => Promise<T>): Promise<T> {
    // Preserve global writer/reference coordination. Never reserve another DB connection while holding this lock.
    await sql`SELECT pg_advisory_lock(71244004)`;
    let directory: string | undefined, finished = false, commitAttempted = false;
    try {
      await durableDirectory(this.stagingDirectory, this.directory);
      directory = await mkdtemp(join(this.stagingDirectory, "txn-"));
      await syncDirectory(this.stagingDirectory);
      await this.intent(directory);
      await sql`BEGIN`;
      const result = await task(async data => {
        const key = sha256(data), target = join(directory!, key);
        let file;
        try { file = await open(target, "wx", 0o600); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await digest((await open(target, "r")).createReadStream());
          if (existing.key !== key) throw new Error("Storage staging integrity mismatch");
          return key;
        }
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await syncDirectory(directory!);
        return key;
      });
      // Disk-backed key iteration avoids an archive-wide in-memory key Set.
      for await (const entry of await opendir(directory)) {
        if (entry.name === "intent.json") continue;
        await (await this.backend()).publish(storageKey(entry.name), join(directory, entry.name));
      }
      commitAttempted = true;
      await sql`COMMIT`;
      finished = true;
      return result;
    } catch (error) {
      try {
        await sql`ROLLBACK`;
        // Even a successful ROLLBACK after a failed COMMIT does not establish its outcome.
        finished = !commitAttempted;
      } catch { /* Keep durable journal for recovery after connection loss. */ }
      throw error;
    } finally {
      try {
        if (finished && directory) await this.clearJournal(directory);
      } finally {
        try { await sql`SELECT pg_advisory_unlock(71244004)`; } catch { /* Lost sessions release their lock server-side. */ }
      }
    }
  }
}
