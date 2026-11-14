import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { SafeFetcher, decodeBody } from "../src/network.js";
import { parseFeed } from "../src/feeds.js";

test("R5 content-coding case and OWS normalization preserves rejection and size/deadline bounds", async () => {
  const body = Buffer.from(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Coding fixture",
      items: [],
    }),
  );
  const encoders = {
    gzip: gzipSync,
    deflate: deflateSync,
    br: brotliCompressSync,
    identity: (bytes: Buffer) => bytes,
  };
  const codings = {
    gzip: " \tGZiP\t ",
    deflate: " DeFLate ",
    br: "\tBR ",
    identity: " IdEnTiTy\t ",
  };
  const server = createServer((request, response) => {
    const [mode, suffix] = request.url!.slice(1).split("/");
    if (mode === "combination") {
      response.writeHead(200, { "content-encoding": " GZIP, bR " });
      response.end(gzipSync(body));
      return;
    }
    const encoding = mode as keyof typeof encoders;
    if (!encoders[encoding]) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-encoding": codings[encoding],
      "content-type": "application/feed+json",
    });
    response.end(
      encoders[encoding](
        suffix === "bomb" ? Buffer.alloc(1024 * 1024, 65) : body,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fetcher = new SafeFetcher(["127.0.0.1"]);
    for (const encoding of Object.keys(encoders) as (keyof typeof encoders)[]) {
      const response = await fetcher.fetch(base + "/" + encoding, {
        maxBytes: 4096,
      });
      assert.equal(
        (await parseFeed(response.body.toString(), base)).title,
        "Coding fixture",
      );
      await assert.rejects(
        fetcher.fetch(base + "/" + encoding + "/bomb", { maxBytes: 4096 }),
        (error: any) => error.code === "FETCH_SIZE",
      );
      if (encoding !== "identity")
        assert.deepEqual(
          await decodeBody(
            encoders[encoding](body),
            codings[encoding],
            4096,
            Date.now() + 1000,
          ),
          body,
        );
    }
    await assert.rejects(
      fetcher.fetch(base + "/combination"),
      (error: any) => error.code === "FETCH_ENCODING",
    );
    await assert.rejects(
      decodeBody(gzipSync(body), " \tGZIP ", 4096, Date.now() - 1),
      (error: any) => error.code === "FETCH_TIMEOUT",
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
