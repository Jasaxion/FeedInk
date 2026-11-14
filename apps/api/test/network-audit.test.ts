import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { SafeFetcher, decodeBody } from "../src/network.js";
import { parseFeed } from "../src/feeds.js";
import { makeZip, readZip } from "../src/zip.js";

test("bounded gzip/br/deflate feed decode and expansion rejection retain the redirect deadline", async () => {
  const feed = Buffer.from(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "压缩源",
      items: [],
    }),
  );
  const encoders = {
    gzip: gzipSync,
    br: brotliCompressSync,
    deflate: deflateSync,
  };
  const server = createServer((request, response) => {
    const path = request.url!.slice(1);
    if (path.startsWith("redirect")) {
      const hop = Number(path.split("/")[1]);
      setTimeout(
        () =>
          response.writeHead(302, { location: `/redirect/${hop + 1}` }).end(),
        25,
      );
      return;
    }
    const encoding = path.split("/")[0] as keyof typeof encoders;
    if (!encoders[encoding]) {
      response.writeHead(404).end();
      return;
    }
    const bytes = encoders[encoding](
      path.endsWith("/bomb") ? Buffer.alloc(1024 * 1024, 65) : feed,
    );
    response.writeHead(200, {
      "content-encoding": encoding,
      "content-type": "application/feed+json",
      "content-length": bytes.length,
    });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fetcher = new SafeFetcher(["127.0.0.1"]);
    for (const encoding of Object.keys(encoders)) {
      const result = await fetcher.fetch(base + "/" + encoding, {
        maxBytes: 4096,
      });
      assert.equal(
        (await parseFeed(result.body.toString(), base)).title,
        "压缩源",
      );
      await assert.rejects(
        fetcher.fetch(base + "/" + encoding + "/bomb", { maxBytes: 4096 }),
        (error: any) => error.code === "FETCH_SIZE",
      );
    }
    await assert.rejects(
      fetcher.fetch(base + "/redirect/0", { timeoutMs: 40 }),
      (error: any) => error.code === "FETCH_TIMEOUT",
    );
    await assert.rejects(
      decodeBody(gzipSync(feed), "gzip", 4096, Date.now() - 1),
      (error: any) => error.code === "FETCH_TIMEOUT",
    );
    await assert.rejects(
      decodeBody(Buffer.from("invalid"), "gzip", 4096, Date.now() + 1000),
      (error: any) => error.code === "FETCH_ENCODING",
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("DNS answer validation rejects mixed private answers and pins the resolved address into the connection", async () => {
  const mixed = new SafeFetcher([], async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    mixed.fetch("http://fixture.invalid/"),
    (error: any) => error.code === "SSRF_BLOCKED",
  );
  let calls = 0,
    seenHost = "";
  const server = createServer((request, response) => {
    seenHost = request.headers.host || "";
    response.end("pinned");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const fetcher = new SafeFetcher(["fixture.invalid"], async () => {
      calls++;
      return [
        { address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 },
      ];
    });
    assert.equal(
      (await fetcher.fetch(`http://fixture.invalid:${port}/`)).body.toString(),
      "pinned",
    );
    assert.equal(calls, 1);
    assert.equal(seenHost, `fixture.invalid:${port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("ZIP reader rejects actual symlink metadata and oversized declared expansion", async () => {
  const bytes = await makeZip([
    { name: "manifest.json", data: Buffer.from("{}") },
  ]);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  const symlink = Buffer.from(bytes);
  symlink.writeUInt16LE(0x0314, central + 4);
  symlink.writeUInt32LE((0xa1ff * 65536) >>> 0, central + 38);
  await assert.rejects(readZip(symlink), /Unsafe|ZIP|archive/);
  const bomb = Buffer.from(bytes);
  bomb.writeUInt32LE(129 * 1024 * 1024, central + 24);
  await assert.rejects(readZip(bomb), /limit|beyond|ZIP|archive/);
});
