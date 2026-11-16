import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { open, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
export type DirectorySync = (directory: string) => Promise<void>;
/** Existence/EEXIST is not a durability receipt. Re-sync every owned edge, leaf to the
 * explicit pre-provisioned root, even after a previous mkdir or parent-fsync failure.
 * The root's own mount/link persistence is the operator's responsibility; never sync its parent. */
export async function durableDirectory(directory: string, root: string, synchronize: DirectorySync = syncDirectory): Promise<void> {
  directory = resolve(directory); root = resolve(root);
  const suffix = relative(root, directory);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`) || resolve(root, suffix) !== directory)
    throw new Error("Directory is outside its storage durability root");
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (!missing(error)) throw error;
    throw new Error("Storage durability root must be pre-provisioned");
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Storage requires real directories");
  const directories = [root];
  for (const part of suffix ? suffix.split(sep) : []) {
    const child = join(directories[directories.length - 1], part);
    try { await mkdir(child, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(child);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Storage requires real directories");
    directories.push(child);
  }
  for (let index = directories.length - 1; index >= 0; index--) await synchronize(directories[index]);
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
