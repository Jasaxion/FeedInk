import yazl from "yazl";
import yauzl from "yauzl";
import { ApiFailure } from "./core.js";
export const ZIP_LIMIT = 128 * 1024 * 1024;
export async function makeZip(
  entries: { name: string; data: Buffer; compress?: boolean }[],
): Promise<Buffer> {
  if (
    entries.length > 6000 ||
    entries.some((e) => e.data.length > 16 * 1024 * 1024) ||
    entries.reduce((sum, e) => sum + e.data.length, 0) > ZIP_LIMIT
  )
    throw new ApiFailure(
      413,
      "ARCHIVE_LIMIT",
      "Archive exceeds expanded size, entry size or entry count limits",
    );
  const zip = new yazl.ZipFile(),
    chunks: Buffer[] = [];
  let size = 0;
  const output = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (b: Buffer) => {
      size += b.length;
      if (size > ZIP_LIMIT) {
        (zip.outputStream as import("node:stream").Readable).destroy();
        reject(
          new ApiFailure(
            413,
            "ARCHIVE_LIMIT",
            "Archive exceeds 128 MiB; export fewer articles",
          ),
        );
      } else chunks.push(b);
    });
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const entry of entries)
    zip.addBuffer(entry.data, entry.name, {
      compress: entry.compress ?? true,
      mtime: new Date("2000-01-01T00:00:00Z"),
    });
  zip.end();
  return output;
}
export async function readZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (buffer.length > ZIP_LIMIT)
    throw new ApiFailure(413, "ARCHIVE_LIMIT", "Archive exceeds 128 MiB");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new ApiFailure(422, "INVALID_ZIP", "Invalid ZIP archive"));
          return;
        }
        const entries = new Map<string, Buffer>();
        let total = 0,
          count = 0,
          stopped = false;
        const stop = (e: unknown) => {
          if (stopped) return;
          stopped = true;
          zip.close();
          reject(
            e instanceof ApiFailure
              ? e
              : new ApiFailure(
                  422,
                  "INVALID_ZIP",
                  "Invalid or truncated ZIP archive",
                ),
          );
        };
        zip.on("error", stop);
        zip.on("end", () => {
          if (!stopped) resolve(entries);
        });
        zip.on("entry", (entry: yauzl.Entry) => {
          const name = entry.fileName,
            mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            ++count > 6000 ||
            entry.uncompressedSize > 16 * 1024 * 1024 ||
            (total += entry.uncompressedSize) > ZIP_LIMIT
          ) {
            stop(
              new ApiFailure(
                413,
                "ARCHIVE_LIMIT",
                "Archive has too many entries or expands beyond limits",
              ),
            );
            return;
          }
          if (
            !/^[a-zA-Z0-9_./-]+$/.test(name) ||
            name.startsWith("/") ||
            name.split("/").some((p) => !p || p === "." || p === "..") ||
            entries.has(name) ||
            entry.generalPurposeBitFlag & 1 ||
            (mode !== 0 && mode !== 0x8000)
          ) {
            stop(
              new ApiFailure(
                422,
                "UNSAFE_ZIP",
                "Unsafe, duplicate or encrypted archive entry",
              ),
            );
            return;
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) {
              stop(e);
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (b: Buffer) => {
              size += b.length;
              if (size > entry.uncompressedSize || size > 16 * 1024 * 1024) {
                stream.destroy();
                stop(
                  new ApiFailure(
                    413,
                    "ARCHIVE_LIMIT",
                    "Expanded entry exceeds its declared size",
                  ),
                );
              } else chunks.push(b);
            });
            stream.on("error", stop);
            stream.on("end", () => {
              if (!stopped) {
                entries.set(name, Buffer.concat(chunks));
                zip.readEntry();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
