import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import postgres from "postgres";
import { createApp } from "../src/app.js";
import { Auth } from "../src/auth.js";
import { type Config, type Row, hash, id } from "../src/core.js";
import { makeZip, readZip } from "../src/zip.js";

async function waitFor(
  check: () => boolean | Promise<boolean>,
  milliseconds = 6000,
) {
  const until = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= until)
      throw new Error("Residual fixture deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "API residual corrections R1–R4",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "feedink-residual-"));
    const config: Config = {
      databaseUrl: process.env.TEST_DATABASE_URL!,
      dataDir: directory,
      appUrl: "http://localhost:3000",
      sessionSecret: "residual-session-secret-over-32-characters",
      host: "127.0.0.1",
      port: 0,
      registration: true,
      fetchAllowHosts: ["127.0.0.1"],
      webDir: join(directory, "no-web"),
      worker: false,
    };
    const db = postgres(config.databaseUrl, { max: 10 }),
      ctx = await createApp(config, db),
      owners: string[] = [];
    const account = async () => {
      const [row] =
        await db`INSERT INTO users(id,email,name,password_hash) VALUES(${id()},${`residual-${id()}@example.invalid`},'Residual fixture','disabled') RETURNING *`;
      owners.push(row.id);
      const token = randomBytes(32).toString("base64url");
      await db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${row.id},now()+interval '1 hour')`;
      return {
        ...row,
        headers: {
          cookie: `feedink_session=${token}`,
          "x-csrf-token": new Auth(db, config).csrf(token),
        },
      };
    };
    const article = async (owner: Row, feedId: string | null = null) => {
      const [row] =
        await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) VALUES(${id()},${owner.id},${feedId},${id()},'Fixture','Body',${base + "/document"},now(),'<p>Good body</p>','Good body',${hash("<p>Good body</p>")}) RETURNING *`;
      return row;
    };
    const feed = async (
      owner: Row,
      url: string,
      etag: string | null = null,
    ) => {
      const [row] =
        await db`INSERT INTO feeds(id,user_id,url,title,site_url,etag) VALUES(${id()},${owner.id},${url},'Fixture',${base + "/page"},${etag}) RETURNING *`;
      const subscription = id();
      await db`INSERT INTO subscriptions(id,user_id,feed_id,title) VALUES(${subscription},${owner.id},${row.id},'Fixture')`;
      return { ...row, subscriptionId: subscription };
    };
    const request = (
      owner: Row,
      method: string,
      path: string,
      payload?: unknown,
    ) =>
      ctx.app.inject({
        method: method as any,
        url: "/api" + path,
        headers: owner.headers,
        payload: payload as any,
      });
    const png = await sharp({
      create: { width: 19, height: 13, channels: 3, background: "#579acc" },
    })
      .png()
      .toBuffer();
    const otherPng = await sharp({
      create: { width: 17, height: 11, channels: 3, background: "#d57527" },
    })
      .png()
      .toBuffer();
    const expansion = `<p lang="${"&".repeat(430000)}">Small text</p>`;
    const held: http.ServerResponse[] = [];
    let base = "",
      offline = false;
    const server = http.createServer((incoming, response) => {
      if (offline) {
        response.writeHead(503).end();
        return;
      }
      if (incoming.url?.startsWith("/image/")) {
        held.push(response);
        return;
      }
      if (incoming.url === "/unchanged") {
        response.writeHead(304).end();
        return;
      }
      if (incoming.url === "/page") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<!-- generated page -->\n<!-- second harmless comment -->\n<!doctype html><html><head><link rel="alternate" type="application/feed+json" href="/good-feed"/></head></html>`,
        );
        return;
      }
      if (incoming.url === "/hostile") {
        response.setHeader("Content-Type", "application/rss+xml");
        response.end(
          '<!-- generated XML --><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
        );
        return;
      }
      if (incoming.url === "/good-feed" || incoming.url === "/expanded-feed") {
        response.setHeader("Content-Type", "application/feed+json");
        response.end(
          JSON.stringify({
            version: "https://jsonfeed.org/version/1.1",
            title: "Fixture feed",
            home_page_url: base + "/page",
            items: [
              {
                id: "one",
                title: "Article",
                url: base + "/document",
                content_html:
                  incoming.url === "/expanded-feed"
                    ? expansion + '<img src="/image/rollback.png"/>'
                    : "<p>Good article body</p>",
              },
            ],
          }),
        );
        return;
      }
      if (incoming.url === "/document") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<html><head><title>Expanded fulltext</title></head><body><article>${expansion}<p>${"This is a complete original text used to exercise fulltext bounds. ".repeat(30)}</p></article></body></html>`,
        );
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await t.test(
        "R1 non-root post-commit cleanup failure releases the store advisory lock",
        async () => {
          assert.ok(
            process.getuid && process.getuid() !== 0,
            "Run this permission regression under a non-root UID",
          );
          const owner = await account(),
            row = await article(owner),
            imageId = id(),
            writer = await db.reserve(),
            probe = await db.reserve();
          let stage: string | undefined,
            probeLocked = false;
          try {
            await assert.rejects(
              ctx.store.writeTransaction(writer, async (put) => {
                const key = await put(png);
                await writer`INSERT INTO images(id,article_id,original_url,status,file_key,content_hash,content_type) VALUES(${imageId},${row.id},${base + "/image/committed.png"},'cached',${key},${hash(png)},'image/png')`;
                const names = await readdir(ctx.store.stagingDirectory);
                stage = join(
                  ctx.store.stagingDirectory,
                  names.find((name) => name.startsWith("txn-"))!,
                );
                await chmod(stage, 0o500);
              }),
              (error: any) => error.code === "EACCES" || error.code === "EPERM",
            );
            const [committed] =
              await probe`SELECT status,file_key FROM images WHERE id=${imageId}`;
            assert.equal(committed.status, "cached");
            assert.deepEqual(await ctx.store.get(committed.file_key), png);
            const [lock] =
              await probe`SELECT pg_try_advisory_lock(71244004) AS acquired`;
            probeLocked = lock.acquired;
            assert.equal(
              probeLocked,
              true,
              "A cleanup error must not leak the writer session lock",
            );
          } finally {
            if (probeLocked) await probe`SELECT pg_advisory_unlock(71244004)`;
            // Also makes the negative pre-fix reproduction safe: this is our reserved backend only.
            await writer`SELECT pg_advisory_unlock_all()`;
            if (stage) await chmod(stage, 0o700);
            await ctx.store.recover(writer);
            writer.release();
            probe.release();
          }
          assert.deepEqual(await readdir(ctx.store.stagingDirectory), []);
          assert.equal(
            (await request(owner, "GET", `/assets/${imageId}`)).statusCode,
            200,
          );
        },
      );
      await t.test(
        "R2 same-image 304 refresh plus retry retains the first successful cache after a late failure or success",
        async () => {
          const owner = await account(),
            source = await feed(owner, base + "/unchanged", '"stable"'),
            row = await article(owner, source.id);
          for (const lateSuccess of [false, true]) {
            const imageId = id();
            await db`INSERT INTO images(id,article_id,original_url) VALUES(${imageId},${row.id},${base + "/image/" + imageId})`;
            const refresh = request(
                owner,
                "POST",
                `/subscriptions/${source.subscriptionId}/refresh`,
                {},
              ),
              retry = request(
                owner,
                "POST",
                `/articles/${row.id}/retry-images`,
                {},
              );
            await waitFor(() => held.length === 2);
            const first = held.shift()!,
              second = held.shift()!;
            first.writeHead(200, { "content-type": "image/png" }).end(png);
            await waitFor(async () => {
              const [image] =
                await db`SELECT status FROM images WHERE id=${imageId}`;
              return image.status === "cached";
            });
            const [successful] =
                await db`SELECT * FROM images WHERE id=${imageId}`,
              files = (await readdir(directory))
                .filter((name) => /^[a-f0-9]{64}$/.test(name))
                .sort();
            if (lateSuccess)
              second
                .writeHead(200, { "content-type": "image/png" })
                .end(otherPng);
            else second.writeHead(503).end();
            await Promise.all([refresh, retry]);
            const [retained] =
              await db`SELECT * FROM images WHERE id=${imageId}`;
            assert.equal(retained.status, "cached");
            assert.equal(retained.file_key, successful.file_key);
            assert.equal(retained.content_hash, successful.content_hash);
            assert.equal(
              retained.captured_at.toISOString(),
              successful.captured_at.toISOString(),
            );
            assert.equal(retained.last_error, null);
            assert.deepEqual(
              (await readdir(directory))
                .filter((name) => /^[a-f0-9]{64}$/.test(name))
                .sort(),
              files,
              "A competing success must not publish replacement bytes",
            );
            offline = true;
            try {
              const asset = await request(owner, "GET", `/assets/${imageId}`);
              assert.equal(asset.statusCode, 200);
              assert.equal(hash(asset.rawPayload), successful.content_hash);
            } finally {
              offline = false;
            }
          }
        },
      );
      await t.test(
        "R3 finalized feed and fulltext HTML bounds prevent unexportable snapshots",
        async () => {
          const owner = await account(),
            source = await feed(owner, base + "/expanded-feed");
          await ctx.feeds.refresh(source);
          const [result] =
            await db`SELECT status,last_error FROM feeds WHERE id=${source.id}`;
          assert.equal(result.status, "error");
          assert.match(result.last_error, /limit/i);
          assert.equal(
            (await db`SELECT id FROM articles WHERE feed_id=${source.id}`)
              .length,
            0,
          );
          assert.equal(
            (
              await db`SELECT i.id FROM images i JOIN articles a ON a.id=i.article_id WHERE a.user_id=${owner.id}`
            ).length,
            0,
          );
          const row = await article(owner);
          await db`UPDATE articles SET fulltext_html='<p>Previously captured fulltext</p>',fulltext_hash=${hash("<p>Previously captured fulltext</p>")},fulltext_fetched_at='2020-01-01T00:00:00Z' WHERE id=${row.id}`;
          assert.equal(await ctx.content.extract(row), false);
          const [retained] =
            await db`SELECT fulltext_html,fulltext_hash,fulltext_fetched_at,fulltext_error FROM articles WHERE id=${row.id}`;
          assert.equal(
            retained.fulltext_html,
            "<p>Previously captured fulltext</p>",
          );
          assert.equal(retained.fulltext_hash, hash(retained.fulltext_html));
          assert.equal(
            retained.fulltext_fetched_at.toISOString(),
            "2020-01-01T00:00:00.000Z",
          );
          assert.match(retained.fulltext_error, /limit/i);
          const target = await account();
          assert.equal(
            (
              await ctx.archives.import(
                target.id,
                await ctx.archives.export(owner.id),
              )
            ).imported,
            1,
          );
        },
      );
      await t.test(
        "R3 imported content and fulltext expansion roll back the entire archive and remain roundtrip-safe",
        async () => {
          const owner = await account(),
            target = await account();
          await article(owner);
          const valid = await ctx.archives.export(owner.id),
            entries = await readZip(valid),
            original = JSON.parse(entries.get("manifest.json")!.toString());
          for (const field of ["contentHtml", "fulltextHtml"]) {
            const manifest = structuredClone(original),
              bad = {
                ...manifest.articles[0],
                id: id(),
                guid: id(),
                url: base + "/oversized-" + field,
                [field]: expansion,
              };
            manifest.articles.push(bad);
            const before = (await readdir(directory)).sort();
            const bytes = await makeZip([
              {
                name: "manifest.json",
                data: Buffer.from(JSON.stringify(manifest)),
              },
            ]);
            await assert.rejects(
              ctx.archives.import(target.id, bytes),
              (error: any) =>
                error.statusCode === 413 && error.code === "CONTENT_SIZE",
            );
            assert.equal(
              (await db`SELECT id FROM articles WHERE user_id=${target.id}`)
                .length,
              0,
            );
            assert.deepEqual((await readdir(directory)).sort(), before);
          }
          assert.equal(
            (await ctx.archives.import(target.id, valid)).imported,
            1,
          );
          const fresh = await account();
          assert.equal(
            (
              await ctx.archives.import(
                fresh.id,
                await ctx.archives.export(target.id),
              )
            ).imported,
            1,
          );
        },
      );
      await t.test(
        "R4 leading HTML comments permit doctype discovery without allowing XML entities",
        async () => {
          const owner = await account();
          const discovered = await request(
            owner,
            "GET",
            `/discover?q=${encodeURIComponent(base + "/page")}`,
          );
          assert.equal(discovered.statusCode, 200, discovered.body);
          assert.equal(discovered.json().feeds[0].url, base + "/good-feed");
          const subscription = await request(owner, "POST", "/subscriptions", {
            url: base + "/page",
          });
          assert.equal(subscription.statusCode, 201, subscription.body);
          assert.equal(subscription.json().status, "ok");
          assert.equal(subscription.json().totalCount, 1);
          assert.equal(
            (
              await request(
                owner,
                "GET",
                `/discover?q=${encodeURIComponent(base + "/hostile")}`,
              )
            ).statusCode,
            400,
          );
          const opml = await request(owner, "POST", "/import/opml", {
            content:
              '<!-- ordinary comment --><!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml><body/></opml>',
          });
          assert.equal(opml.statusCode, 400);
        },
      );
    } finally {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await ctx.app.close();
      for (const owner of owners) await db`DELETE FROM users WHERE id=${owner}`;
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
