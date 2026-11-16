import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { open, lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StorageConfig } from "./config.js";

export function storageKey(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
  return key;
}
export const fanoutKey = (key: string) => `${storageKey(key).slice(0, 2)}/${key.slice(2, 4)}/${key}`;
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Sync each newly created directory and its parent; recursive mkdir alone is not durable. */
export async function durableDirectory(directory: string): Promise<void> {
  directory = resolve(directory);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Storage requires real directories");
  } catch (error) {
    if (!missing(error)) throw error;
    await durableDirectory(dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Storage requires real directories");
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
}
export async function digest(stream: Readable): Promise<{ key: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (!Number.isSafeInteger(size)) throw new Error("Blob size exceeds supported integer range");
    hash.update(bytes);
  }
  return { key: hash.digest("hex"), size };
}
export interface BlobBackend {
  init(): Promise<void>;
  read(key: string): Promise<Readable>;
  size(key: string): Promise<number>;
  /** Publish without replacing any existing key, then verify exact bytes (not ETag). */
  publish(key: string, stagedFile: string): Promise<void>;
  assertEmpty(): Promise<void>;
  identity(): string;
}
export async function verifyBlob(backend: BlobBackend, key: string) {
  const result = await digest(await backend.read(storageKey(key)));
  if (result.key !== key) throw new Error("Blob integrity mismatch");
  return result;
}
export async function createBackend(directory: string, config?: StorageConfig): Promise<BlobBackend> {
  // Lazy loading keeps default filesystem archives independent of S3 initialization/services.
  if (config?.backend === "s3") {
    const { S3Backend } = await import("./s3.js");
    return new S3Backend(config);
  }
  const { FilesystemBackend } = await import("./filesystem.js");
  return new FilesystemBackend(directory);
}
