import { constants } from "node:fs";
import { link, lstat, open, opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { durableDirectory, fanoutKey, missing, storageKey, syncDirectory, verifyBlob, type BlobBackend, type DirectorySync } from "./backend.js";

export class FilesystemBackend implements BlobBackend {
  constructor(readonly directory: string, private readonly synchronize: DirectorySync = syncDirectory) {}
  identity() { return `filesystem:${resolve(this.directory)}`; }
  async init() { await durableDirectory(this.directory, this.directory, this.synchronize); }
  path(key: string) { return join(this.directory, fanoutKey(key)); }
  private async locate(key: string) {
    const file = this.path(key);
    try { await lstat(file); return file; } catch (error) { if (!missing(error)) throw error; }
    return join(this.directory, storageKey(key));
  }
  async read(key: string): Promise<Readable> {
    const handle = await open(await this.locate(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Blob is not a regular file");
      return handle.createReadStream();
    } catch (error) { await handle.close(); throw error; }
  }
  async size(key: string) {
    const info = await lstat(await this.locate(key));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Blob is not a regular file");
    return info.size;
  }
  async publish(key: string, stagedFile: string) {
    const target = this.path(key);
    await durableDirectory(dirname(target), this.directory, this.synchronize);
    try { await link(stagedFile, target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.synchronize(dirname(target));
    await verifyBlob(this, key);
  }
  async assertEmpty() {
    const entries = await opendir(this.directory);
    for await (const _entry of entries) throw new Error("Restore requires an empty blob target");
  }
}
