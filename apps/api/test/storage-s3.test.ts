import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Backend } from "../src/storage/s3.js";
import { digest } from "../src/storage/backend.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
test("S3 backend uses immutable conditional keys, verifies bytes instead of ETags, and never deletes unknown uploads", async t => {
  const directory = await mkdtemp(join(tmpdir(), "feedink-s3-protocol-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new S3Backend({ backend: "s3", bucket: "synthetic", prefix: "private/", region: "us-east-1" });
  t.after(() => backend.client.destroy());
  const bytes = Buffer.from("synthetic object bytes"), key = hash(bytes), file = join(directory, key);
  await writeFile(file, bytes);
  const objects = new Map<string, Buffer>(), commands: string[] = [];
  let unavailable = false, acknowledgementLost = true;
  backend.client.send = (async (command: any) => {
    const name = command.constructor.name, input = command.input; commands.push(name);
    if (unavailable) throw new Error("synthetic S3 outage");
    assert.equal(input.Bucket, "synthetic");
    if (name === "ListObjectsV2Command") return { Contents: objects.size ? [{ Key: "private/fixture" }] : [] };
    assert.equal(input.Key, `private/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`);
    if (name === "PutObjectCommand") {
      assert.equal(input.IfNoneMatch, "*"); assert.equal(input.ACL, undefined);
      assert.equal(input.ChecksumSHA256, Buffer.from(key, "hex").toString("base64"));
      if (objects.has(input.Key)) throw Object.assign(new Error("conditional collision"), { $metadata: { httpStatusCode: 412 } });
      const chunks: Buffer[] = []; for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      objects.set(input.Key, Buffer.concat(chunks));
      if (acknowledgementLost) { acknowledgementLost = false; throw new Error("upload acknowledgement lost"); }
      return {};
    }
    const value = objects.get(input.Key);
    if (!value) throw new Error("synthetic missing object");
    if (name === "HeadObjectCommand") return { ContentLength: value.length };
    if (name === "GetObjectCommand") return { Body: Readable.from([value]), ETag: "not-a-sha256" };
    throw new Error("Unexpected/deleting operation");
  }) as any;
  await backend.assertEmpty();
  await assert.rejects(backend.publish(key, file), /Private object storage publish failed/);
  assert.equal(objects.size, 1);
  await backend.publish(key, file);
  assert.deepEqual(await digest(await backend.read(key)), { key, size: bytes.length });
  assert.equal(await backend.size(key), bytes.length);
  await assert.rejects(backend.assertEmpty(), /empty S3 prefix/);
  unavailable = true;
  await assert.rejects(backend.publish(key, file), /Private object storage publish failed/); await assert.rejects(backend.read(key), /Private object storage read failed/);
  assert.equal(objects.size, 1);
  unavailable = false;
  objects.set(`private/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`, Buffer.from("corrupt"));
  await assert.rejects(backend.publish(key, file), /integrity mismatch/);
  assert.ok(!commands.some(name => name.includes("Delete")));
  objects.clear(); await assert.rejects(backend.read(key), /Private object storage read failed/);
});
