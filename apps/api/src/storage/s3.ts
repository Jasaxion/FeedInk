import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { fanoutKey, storageKey, verifyBlob, type BlobBackend } from "./backend.js";
import { validateStorageConfig, type StorageConfig } from "./config.js";

type S3Config = Extract<StorageConfig, { backend: "s3" }>;
/** No ACL, public URL, presigning or DeleteObject operation is exposed. */
export class S3Backend implements BlobBackend {
  readonly client: S3Client;
  readonly config: S3Config;
  constructor(config: S3Config) {
    this.config = validateStorageConfig(config) as S3Config;
    this.client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle,
      maxAttempts: 3, requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  identity() { return `s3:${this.config.endpoint || "aws"}:${this.config.region}:${this.config.bucket}:${this.config.prefix || ""}`; }
  async init() { /* Bucket creation, private policy and lifecycle are operator responsibilities. */ }
  private address(key: string) { return { Bucket: this.config.bucket, Key: (this.config.prefix || "") + fanoutKey(key) }; }
  async read(key: string): Promise<Readable> {
    const address = this.address(key);
    const result = await this.client.send(new GetObjectCommand(address)).catch(() => {
      throw new Error("Private object storage read failed");
    });
    if (!(result.Body instanceof Readable)) throw new Error("S3 object has no readable body");
    return result.Body;
  }
  async size(key: string) {
    const address = this.address(key);
    const result = await this.client.send(new HeadObjectCommand(address)).catch(() => {
      throw new Error("Private object storage metadata failed");
    });
    if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0) throw new Error("S3 object has invalid size");
    return result.ContentLength!;
  }
  async publish(key: string, stagedFile: string) {
    storageKey(key);
    const size = (await stat(stagedFile)).size;
    // Existing API blobs fit well below single-PUT's 5GiB bound. Never silently multipart/overwrite.
    if (size > 5 * 1024 ** 3) throw new Error("S3 blob exceeds single-PUT limit");
    const body = createReadStream(stagedFile);
    try {
      await this.client.send(new PutObjectCommand({ ...this.address(key), Body: body, ContentLength: size,
        IfNoneMatch: "*", ChecksumSHA256: Buffer.from(key, "hex").toString("base64"), ContentType: "application/octet-stream" }));
    } catch (error) {
      const code = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code !== 412 && code !== 409) throw new Error("Private object storage publish failed");
      // A competing/ambiguous publish is accepted only if GET proves the existing bytes.
    } finally { body.destroy(); }
    await verifyBlob(this, key);
  }
  async assertEmpty() {
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: this.config.prefix || "", MaxKeys: 1 })).catch(() => {
      throw new Error("Private object storage inventory failed");
    });
    if (result.Contents?.length || result.IsTruncated) throw new Error("Restore requires an empty S3 prefix");
  }
}
