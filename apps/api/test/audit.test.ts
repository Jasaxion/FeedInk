import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, mkdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import sharp from "sharp";
import postgres from "postgres";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import {
  type Config,
  type Row,
  id,
  hash,
  withConnection,
  parseTrustedProxies,
} from "../src/core.js";
import { Auth, passwordHash } from "../src/auth.js";
import { bootstrapAdmin, reconcileEbook } from "../src/operators.js";
import { makeZip, readZip } from "../src/zip.js";

const deadline = <T>(promise: Promise<T>, ms = 12000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Regression exceeded bounded deadline")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
test(
  "independent audit regressions against isolated PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "feedink-audit-"));
    const queries: string[] = [];
    const config: Config = {
      databaseUrl: process.env.TEST_DATABASE_URL!,
      dataDir: directory,
      appUrl: "http://localhost:3000",
      sessionSecret: "audit-secret-is-at-least-32-characters",
      host: "127.0.0.1",
      port: 0,
      registration: true,
      adminEmail: "bootstrap-target@example.invalid",
      fetchAllowHosts: ["127.0.0.1"],
      webDir: join(directory, "absent"),
      worker: false,
    };
    const db = postgres(config.databaseUrl, {
        max: 10,
        debug: (_id, query) => queries.push(query),
      }),
      ctx = await createApp(config, db),
      owners: string[] = [];
    const digest = await passwordHash("audit-password-long");
    const account = async () => {
      const [row] =
        await db`INSERT INTO users(id,email,name,password_hash) VALUES(${id()},${`audit-${id()}@example.invalid`},'Audit',${digest}) RETURNING *`;
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
    const article = async (
      owner: Row,
      feedId: string | null = null,
      title = "Audit article",
    ) => {
      const [row] =
        await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) VALUES(${id()},${owner.id},${feedId},${id()},'Audit feed',${title},'https://example.org/a',now(),'<p>Body</p>','Body',${hash("<p>Body</p>")}) RETURNING *`;
      return row;
    };
    const feed = async (
      owner: Row,
      url: string,
      folderId: string | null = null,
    ) => {
      const [row] =
        await db`INSERT INTO feeds(id,user_id,url,title,site_url) VALUES(${id()},${owner.id},${url},'Audit feed',${url}) RETURNING *`;
      await db`INSERT INTO subscriptions(id,user_id,feed_id,title,folder_id) VALUES(${id()},${owner.id},${row.id},'Audit feed',${folderId})`;
      return row;
    };
    const request = (
      owner: Row,
      method: string,
      path: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) =>
      ctx.app.inject({
        method: method as any,
        url: "/api" + path,
        payload: payload as any,
        headers: { ...owner.headers, ...headers },
      });
    const png = await sharp({
      create: { width: 31, height: 17, channels: 3, background: "#5e66aa" },
    })
      .png()
      .toBuffer();
    let base = "",
      gated = 0,
      gateEnabled = false,
      online = true,
      allArrived: () => void = () => {};
    const held: http.ServerResponse[] = [];
    const rss = (path: string) =>
      `<rss version="2.0"><channel><title>Audit feed</title><link>${base}/site</link><image><url>${base}/icon.png</url></image><item><guid>${path}</guid><title>Captured article</title><link>${base}/article</link><description><![CDATA[<p>Durable article</p><img data-src="${base}/image.png"/>]]></description></item></channel></rss>`;
    const upstream = http.createServer((req, res) => {
      if (!online) {
        res.writeHead(503).end();
        return;
      }
      if (req.url?.startsWith("/gated/") && gateEnabled) {
        held.push(res);
        gated++;
        if (gated === 10) allArrived();
        return;
      }
      if (req.url === "/image.png" || req.url === "/icon.png") {
        res.setHeader("Content-Type", "image/png");
        res.end(png);
        return;
      }
      if (req.url === "/site") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/capture"/><link rel="icon" href="/icon.png"/></head></html>`,
        );
        return;
      }
      if (req.url === "/metadata") {
        res.setHeader("Content-Type", "application/feed+json");
        res.end(
          JSON.stringify({
            version: "https://jsonfeed.org/version/1.1",
            title: "Feed\u0001title",
            home_page_url: base + "/site",
            icon: base + "/icon.png",
            items: [
              {
                id: "metadata",
                title: "Article\u0001title",
                url: base + "/article",
                authors: [{ name: "author".repeat(400) }],
                content_html: "<p>Metadata body</p>",
                attachments: [
                  {
                    url: base + "/audio",
                    mime_type: "x".repeat(400),
                    size_in_bytes: -1,
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/xxe") {
        res.end(
          '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
        );
        return;
      }
      if (req.url === "/invalid-icon") {
        res.end(
          JSON.stringify({
            version: "https://jsonfeed.org/version/1.1",
            title: "Bad icon",
            icon: base + "/xxe",
            items: [],
          }),
        );
        return;
      }
      if (
        req.url === "/capture" &&
        req.headers["if-none-match"] === '"capture"'
      ) {
        res.writeHead(304).end();
        return;
      }
      if (req.url === "/capture" || req.url?.startsWith("/gated/")) {
        res.setHeader("ETag", '"capture"');
        res.end(rss(req.url));
        return;
      }
      res.writeHead(404).end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    base = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    try {
      await t.test(
        "F1: ten gated refreshes use their reserved executors and worker does not reserve recursively",
        async () => {
          const owner = await account(),
            records = [];
          for (let i = 0; i < 10; i++)
            records.push(await feed(owner, `${base}/gated/${i}`));
          const subscriptions = await ctx.feeds.subscriptions(owner.id);
          // Reproduce the old pool mechanism in a bounded way, then release it.
          const reservations = await Promise.all(
            Array.from({ length: 10 }, () => db.reserve()),
          );
          let healthCompleted = false;
          const blockedHealth = db`SELECT 1`.then(() => {
            healthCompleted = true;
          });
          await new Promise((r) => setTimeout(r, 60));
          assert.equal(healthCompleted, false);
          for (const sql of reservations) sql.release();
          await deadline(blockedHealth);
          gateEnabled = true;
          const arrived = new Promise<void>((resolve) => {
            allArrived = resolve;
          });
          const calls = subscriptions.map((s) =>
            request(owner, "POST", `/subscriptions/${s.id}/refresh`, {}),
          );
          await deadline(arrived);
          assert.equal(gated, 10);
          held.forEach((response, index) =>
            response.end(rss(`/gated/${index}`)),
          );
          held.length = 0;
          gateEnabled = false;
          const responses = await deadline(Promise.all(calls));
          assert.ok(
            responses.every(
              (r) => r.statusCode === 200 && r.json().status === "ok",
            ),
            responses.map((r) => r.body).join("\n"),
          );
          assert.equal(
            (await deadline(ctx.app.inject({ url: "/api/health" }))).statusCode,
            200,
          );
          await db`UPDATE feeds SET next_fetch_at=now() WHERE user_id=${owner.id}`;
          await deadline(ctx.tick());
        },
      );
      await t.test(
        "F2: ADMIN_EMAIL registration cannot elevate; operator bootstrap refuses takeover and races",
        async () => {
          const response = await ctx.app.inject({
            method: "POST",
            url: "/api/auth/register",
            payload: {
              email: config.adminEmail,
              password: "attacker-chosen-password",
              name: "Not administrator",
            },
          });
          assert.equal(response.statusCode, 201, response.body);
          owners.push(response.json().user.id);
          assert.equal(response.json().user.isAdmin, false);
          await assert.rejects(
            bootstrapAdmin(db, {
              email: config.adminEmail,
              password: "operator-password-long",
              name: "Owner",
            }),
            /unused email/,
          );
          const bootstrap = await Promise.allSettled([
            bootstrapAdmin(db, {
              email: `owner-${id()}@example.invalid`,
              password: "operator-password-long",
              name: "Owner",
            }),
            bootstrapAdmin(db, {
              email: `owner-${id()}@example.invalid`,
              password: "operator-password-long",
              name: "Owner",
            }),
          ]);
          assert.equal(
            bootstrap.filter((r) => r.status === "fulfilled").length,
            1,
          );
          for (const r of bootstrap)
            if (r.status === "fulfilled") {
              owners.push(r.value);
              const [row] =
                await db`SELECT is_admin FROM users WHERE id=${r.value}`;
              assert.equal(row.is_admin, true);
              await db`DELETE FROM users WHERE id=${r.value}`;
            }
        },
      );
      await t.test(
        "operator bootstrap CLI bounds stdin and never logs password data",
        async () => {
          const email = `cli-${id()}@example.invalid`,
            secret = "stdin-bootstrap-password";
          const env = {
            ...process.env,
            DATABASE_URL: config.databaseUrl,
            SESSION_SECRET: config.sessionSecret,
            ADMIN_EMAIL: email,
            ADMIN_PASSWORD_FILE: "/dev/stdin",
            NODE_ENV: "test",
          };
          const result = spawnSync(
            process.execPath,
            ["dist/operator-cli.js", "bootstrap-admin"],
            { env, input: secret + "\n", encoding: "utf8", timeout: 15000 },
          );
          assert.equal(result.status, 0, result.stderr);
          assert.ok(!result.stdout.includes(secret));
          assert.ok(!result.stderr.includes(secret));
          const [created] =
            await db`SELECT id,is_admin FROM users WHERE email=${email}`;
          assert.equal(created.is_admin, true);
          owners.push(created.id);
          await db`DELETE FROM users WHERE id=${created.id}`;
          const oversized = spawnSync(
            process.execPath,
            ["dist/operator-cli.js", "bootstrap-admin"],
            { env, input: "x".repeat(1025), encoding: "utf8", timeout: 15000 },
          );
          assert.notEqual(oversized.status, 0);
          assert.match(oversized.stderr, /1024 bytes/);
          assert.ok(!oversized.stderr.includes("x".repeat(100)));
        },
      );
      await t.test(
        "F6/F7: HTML doctype works; interrupted capture rolls back and pending images resume on 304",
        async () => {
          const owner = await account();
          assert.equal(
            (
              await request(
                owner,
                "GET",
                `/discover?q=${encodeURIComponent(base + "/site")}`,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await request(
                owner,
                "GET",
                `/discover?q=${encodeURIComponent(base + "/xxe")}`,
              )
            ).statusCode,
            400,
          );
          const source = await feed(owner, base + "/capture"),
            originalCapture = ctx.content.capture.bind(ctx.content),
            originalCache = ctx.content.cacheImage.bind(ctx.content);
          ctx.content.capture = async () => {
            throw new Error(
              "Injected process interruption before capture commit",
            );
          };
          try {
            await ctx.feeds.refresh(source);
            assert.equal(
              (await db`SELECT id FROM articles WHERE feed_id=${source.id}`)
                .length,
              0,
            );
          } finally {
            ctx.content.capture = originalCapture;
          }
          ctx.content.cacheImage = async () => {
            throw new Error("Injected interruption after article commit");
          };
          try {
            await ctx.feeds.refresh(source);
          } finally {
            ctx.content.cacheImage = originalCache;
          }
          const [retained] =
            await db`SELECT * FROM articles WHERE feed_id=${source.id}`;
          assert.match(retained.content_html, /\/api\/assets\//);
          assert.equal(
            (
              await db`SELECT status FROM images WHERE article_id=${retained.id}`
            )[0].status,
            "pending",
          );
          const [current] = await db`SELECT * FROM feeds WHERE id=${source.id}`;
          await ctx.feeds.refresh(current);
          assert.equal(
            (
              await db`SELECT status FROM images WHERE article_id=${retained.id}`
            )[0].status,
            "cached",
          );
          online = false;
          try {
            const detail = await request(
              owner,
              "GET",
              `/articles/${retained.id}`,
            );
            assert.equal(detail.statusCode, 200);
            assert.match(detail.json().contentHtml, /Durable article/);
            assert.equal(
              (
                await request(
                  owner,
                  "GET",
                  detail.json().images[0].url.replace("/api", ""),
                )
              ).statusCode,
              200,
            );
          } finally {
            online = true;
          }
        },
      );
      await t.test(
        "F3/F8/F10: metadata normalization, provenance, rejected and skipped import storage deltas",
        async () => {
          const sourceOwner = await account(),
            target = await account();
          const subscription = await ctx.feeds.subscribe(sourceOwner.id, {
            url: base + "/metadata",
          });
          assert.equal(subscription.status, "ok");
          const [source] =
            await db`SELECT * FROM articles WHERE feed_id=${subscription.feedId}`;
          assert.equal(source.author.length, 1000);
          assert.equal(source.enclosures[0].length, undefined);
          assert.equal(source.enclosures[0].type.length, 200);
          assert.equal(source.title, "Articletitle");
          // Also normalize already-persisted legacy metadata on export.
          await db`UPDATE articles SET author=${"a".repeat(2000)},enclosures=${db.json([{ url: base + "/audio", type: "t".repeat(400), length: -1 }])},fulltext_html='<p>Original extracted snapshot</p>',fulltext_fetched_at='2021-02-03T04:05:06Z' WHERE id=${source.id}`;
          const imageId = id(),
            pendingId = id(),
            failedId = id();
          await withConnection(db, (sql) =>
            ctx.store.writeTransaction(sql, async (put) => {
              const key = await put(png);
              await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_type,content_hash,captured_at) VALUES(${imageId},${source.id},${base + "/image.png"},'cached',${key},'image/png',${hash(png)},'2020-01-02T03:04:05Z')`;
              await sql`INSERT INTO images(id,article_id,original_url,status) VALUES(${pendingId},${source.id},${base + "/pending.png"},'pending'),(${failedId},${source.id},${base + "/failed.png"},'failed')`;
            }),
          );
          const zip = await ctx.archives.export(sourceOwner.id),
            entries = await readZip(zip),
            manifest = JSON.parse(entries.get("manifest.json")!.toString());
          assert.equal(manifest.version, 3);
          const imported = await ctx.archives.import(target.id, zip);
          assert.equal(imported.imported, 1);
          const [restored] =
            await db`SELECT * FROM articles WHERE user_id=${target.id}`;
          assert.equal(
            restored.fulltext_fetched_at.toISOString(),
            "2021-02-03T04:05:06.000Z",
          );
          assert.ok(restored.restored_at);
          const restoredImages =
            await db`SELECT * FROM images WHERE article_id=${restored.id}`;
          assert.equal(
            restoredImages
              .find((i) => i.status === "cached")!
              .captured_at.toISOString(),
            "2020-01-02T03:04:05.000Z",
          );
          assert.ok(restoredImages.some((i) => i.status === "pending"));
          assert.ok(restoredImages.some((i) => i.status === "failed"));
          const variant = await sharp({
            create: {
              width: 29,
              height: 19,
              channels: 3,
              background: "#11ee55",
            },
          })
            .png()
            .toBuffer();
          const duplicate = await makeZip(
            [...entries].map(([name, data]) => ({
              name,
              data: name === `images/${imageId}.png` ? variant : data,
            })),
          );
          let before = (await readdir(directory)).sort();
          assert.equal(
            (await ctx.archives.import(target.id, duplicate)).skipped,
            1,
          );
          assert.deepEqual((await readdir(directory)).sort(), before);
          const hostile = structuredClone(manifest);
          hostile.articles[0].guid = id();
          const second = id();
          hostile.articles[0].images = [
            {
              id: imageId,
              originalUrl: base + "/new.png",
              status: "cached",
              path: `images/${imageId}.png`,
            },
            {
              id: second,
              originalUrl: base + "/bad.png",
              status: "cached",
              path: `images/${second}.png`,
            },
          ];
          const rejected = await makeZip([
            {
              name: "manifest.json",
              data: Buffer.from(JSON.stringify(hostile)),
            },
            { name: `images/${imageId}.png`, data: variant },
            { name: `images/${second}.png`, data: Buffer.from("not an image") },
          ]);
          await assert.rejects(
            ctx.archives.import(target.id, rejected),
            /unsupported|invalid/,
          );
          assert.deepEqual((await readdir(directory)).sort(), before);
          assert.equal(
            (await db`SELECT id FROM articles WHERE user_id=${target.id}`)
              .length,
            1,
          );
          await assert.rejects(
            withConnection(db, (sql) =>
              ctx.store.writeTransaction(sql, async (put) => {
                await put(variant);
                throw new Error("Injected transaction rollback");
              }),
            ),
            /rollback/,
          );
          assert.deepEqual((await readdir(directory)).sort(), before);
          // Legacy crash remnants are recovered explicitly during maintenance, not by a startup root scan.
          // Conservatively retain unknown published bytes; a hash does not prove exclusive ownership.
          const stage = await mkdtemp(join(directory, ".stage-")),
            orphan = hash(variant),
            shared = hash(png);
          await writeFile(join(stage, orphan), variant);
          await link(join(stage, orphan), join(directory, orphan));
          await writeFile(join(stage, shared), png);
          await withConnection(db, (sql) => ctx.store.recoverLegacy(sql));
          assert.deepEqual((await readdir(directory)).sort(), [...before, orphan].sort());
          assert.deepEqual(await ctx.store.get(orphan), variant);
          assert.deepEqual(await ctx.store.get(shared), png);
          assert.deepEqual(await readdir(ctx.store.stagingDirectory), []);
        },
      );
      await t.test(
        "F4: large and JSON-escaping-heavy manifests fail before body or file materialization",
        async () => {
          const owner = await account();
          await db`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,fulltext_html,content_text,content_hash) SELECT gen_random_uuid(),${owner.id},g::text,'Large','Large','https://example.org/large',now(),repeat('x',524288),repeat('y',524288),'','fixture' FROM generate_series(1,32) g`;
          queries.length = 0;
          await assert.rejects(
            ctx.archives.export(owner.id),
            (e: any) => e.statusCode === 413,
          );
          assert.ok(
            !queries.some((q) => q.includes("SELECT id,feed_id,guid")),
            "No full-body fetch before preflight rejection",
          );
          await db`DELETE FROM articles WHERE user_id=${owner.id}`;
          await db`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) SELECT gen_random_uuid(),${owner.id},g::text,'Escaped','Escaped','https://example.org/escaped',now(),repeat(chr(1),1000000),'','fixture' FROM generate_series(1,3) g`;
          queries.length = 0;
          await assert.rejects(
            ctx.archives.export(owner.id),
            (e: any) => e.statusCode === 413,
          );
          assert.ok(!queries.some((q) => q.includes("SELECT id,feed_id,guid")));
        },
      );
      await t.test(
        "feed icons are bounded local assets, authorized and preserve safe fallback",
        async () => {
          const owner = await account(),
            other = await account();
          const good = await ctx.feeds.subscribe(owner.id, {
            url: base + "/metadata",
          });
          assert.equal(good.iconUrl, `/api/feed-icons/${good.feedId}`);
          assert.equal(
            (await request(owner, "GET", good.iconUrl!.replace("/api", "")))
              .statusCode,
            200,
          );
          assert.equal(
            (await request(other, "GET", good.iconUrl!.replace("/api", "")))
              .statusCode,
            404,
          );
          assert.equal(
            (await ctx.app.inject({ url: good.iconUrl! })).statusCode,
            401,
          );
          const bad = await ctx.feeds.subscribe(owner.id, {
            url: base + "/invalid-icon",
          });
          assert.equal(bad.iconUrl, null);
        },
      );
      await t.test(
        "state fencing rejects delayed older writes including tag changes; bulk increments versions",
        async () => {
          const owner = await account(),
            other = await account(),
            row = await article(owner);
          const initial = await request(owner, "GET", `/articles/${row.id}`);
          assert.equal(initial.json().stateVersion, 0);
          assert.equal(initial.headers.etag, '"0"');
          const tag = id();
          await db`INSERT INTO tags(id,user_id,name) VALUES(${tag},${owner.id},'Fence')`;
          const current = await request(
            owner,
            "PATCH",
            `/articles/${row.id}/state`,
            { read: true, tagIds: [tag] },
            { "if-match": '"0"' },
          );
          assert.equal(current.statusCode, 200);
          assert.equal(current.json().stateVersion, 1);
          const stale = await request(
            owner,
            "PATCH",
            `/articles/${row.id}/state`,
            { read: false, saved: true, tagIds: [] },
            { "if-match": '"0"' },
          );
          assert.equal(stale.statusCode, 412);
          assert.equal(stale.json().error.code, "STATE_CONFLICT");
          let state = (
            await request(owner, "GET", `/articles/${row.id}`)
          ).json();
          assert.equal(state.read, true);
          assert.equal(state.saved, false);
          assert.equal(state.tags[0].id, tag);
          await request(owner, "POST", "/articles/bulk-state", {
            ids: [row.id],
            read: false,
          });
          state = (await request(owner, "GET", `/articles/${row.id}`)).json();
          assert.equal(state.stateVersion, 2);
          assert.equal(
            (
              await request(
                owner,
                "PATCH",
                `/articles/${row.id}/state`,
                { saved: true },
                { "if-match": '"1"' },
              )
            ).statusCode,
            412,
          );
          assert.equal(
            (
              await request(
                other,
                "PATCH",
                `/articles/${row.id}/state`,
                { read: true },
                { "if-match": '"2"' },
              )
            ).statusCode,
            404,
          );
          const concurrent = await Promise.all([
            request(
              owner,
              "PATCH",
              `/articles/${row.id}/state`,
              { saved: true },
              { "if-match": '"2"' },
            ),
            request(
              owner,
              "PATCH",
              `/articles/${row.id}/state`,
              { progress: 0.3 },
              { "if-match": '"2"' },
            ),
          ]);
          assert.deepEqual(
            concurrent.map((r) => r.statusCode).sort(),
            [200, 412],
          );
        },
      );
      await t.test(
        "F5: uncertain SMTP reservations survive later buckets and explicit reconciliation; ebook folder selection",
        async () => {
          const owner = await account(),
            active = await feed(owner, base + "/mail"),
            selected = await article(owner, active.id),
            external = await article(owner);
          await db`UPDATE articles SET saved=true WHERE id=${external.id}`;
          await db`UPDATE users SET settings=${db.json({ ebookAutoSend: true, ebookEmail: "reader@example.invalid", ebookHour: 0, ebookIntervalDays: 1, ebookMinArticles: 1, ebookMaxArticles: 10 })} WHERE id=${owner.id}`;
          let messages = 0,
            drop = true;
          const sockets = new Set<net.Socket>();
          const smtp = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.write("220 fixture ESMTP\r\n");
            let buffer = "",
              data = false;
            socket.on("data", (chunk) => {
              buffer += chunk.toString();
              while (buffer.includes("\r\n")) {
                const i = buffer.indexOf("\r\n"),
                  line = buffer.slice(0, i);
                buffer = buffer.slice(i + 2);
                if (data) {
                  if (line === ".") {
                    data = false;
                    messages++;
                    if (drop) socket.destroy();
                    else socket.write("250 accepted\r\n");
                  }
                  continue;
                }
                if (/^EHLO|HELO/.test(line)) socket.write("250 fixture\r\n");
                else if (line === "DATA") {
                  data = true;
                  socket.write("354 continue\r\n");
                } else if (line === "QUIT") socket.end("221 bye\r\n");
                else socket.write("250 ok\r\n");
              }
            });
          });
          smtp.listen(0, "127.0.0.1");
          await once(smtp, "listening");
          process.env.SMTP_HOST = "127.0.0.1";
          process.env.SMTP_PORT = String(
            (smtp.address() as net.AddressInfo).port,
          );
          process.env.SMTP_FROM = "fixture@example.invalid";
          try {
            await ctx.ebooks.schedules(new Date("2040-01-01T12:00:00Z"));
            const [job] =
              await db`SELECT * FROM ebooks WHERE user_id=${owner.id}`;
            assert.equal(messages, 1);
            assert.equal(job.delivery_state, "unknown");
            assert.equal(job.sent_at, null);
            assert.deepEqual(
              (
                await db`SELECT article_id FROM ebook_articles WHERE ebook_id=${job.id}`
              ).map((r) => r.article_id),
              [selected.id],
            );
            drop = false;
            await ctx.ebooks.schedules(new Date("2040-01-02T12:00:00Z"));
            assert.equal(messages, 1);
            assert.equal(
              (await db`SELECT id FROM ebooks WHERE user_id=${owner.id}`)
                .length,
              1,
            );
            await reconcileEbook(db, job.id, "not-delivered");
            await ctx.ebooks.schedules(new Date("2040-01-03T12:00:00Z"));
            assert.equal(messages, 2);
            const folder = id();
            await db`INSERT INTO folders(id,user_id,name) VALUES(${folder},${owner.id},'ebook')`;
            const chosen = await feed(owner, base + "/chosen", folder),
              chosenArticle = await article(owner, chosen.id);
            await article(owner, active.id);
            await ctx.ebooks.schedules(new Date("2040-01-04T12:00:00Z"));
            const [last] =
              await db`SELECT id FROM ebooks WHERE user_id=${owner.id} ORDER BY created_at DESC LIMIT 1`;
            assert.deepEqual(
              (
                await db`SELECT article_id FROM ebook_articles WHERE ebook_id=${last.id}`
              ).map((r) => r.article_id),
              [chosenArticle.id],
            );
            await db`UPDATE users SET settings='{}' WHERE id=${owner.id}`;
          } finally {
            delete process.env.SMTP_HOST;
            delete process.env.SMTP_PORT;
            delete process.env.SMTP_FROM;
            for (const socket of sockets) socket.destroy();
            smtp.close();
            await once(smtp, "close");
          }
        },
      );
      await t.test(
        "F11: control characters in supplied and source metadata produce well-formed EPUB XML",
        async () => {
          const owner = await account(),
            row = await article(owner, null, "Source\u0001 title");
          await db`UPDATE articles SET content_html=${'<p>Body\u0001 text &#1;</p><p title="&#x1;">Encoded control</p>'} WHERE id=${row.id}`;
          const response = await request(owner, "POST", "/ebooks", {
            articleIds: [row.id],
            title: "Read\u0001me",
          });
          assert.equal(response.statusCode, 201, response.body);
          assert.equal(response.json().title, "Readme");
          const file = await request(
            owner,
            "GET",
            response.json().downloadUrl.replace("/api", ""),
          );
          for (const [name, bytes] of await readZip(file.rawPayload))
            if (/\.(xml|opf|xhtml)$/.test(name)) {
              const dom = new JSDOM(bytes.toString(), {
                contentType: "application/xml",
              });
              dom.window.close();
            }
        },
      );
      await t.test(
        "global API limit returns 429 envelope and Retry-After while static shell has a separate budget",
        async () => {
          const webDir = join(directory, "shell-static");
          await mkdir(webDir);
          await writeFile(
            join(webDir, "index.html"),
            "<!doctype html><title>Audit shell</title>",
          );
          const bounded = await createApp({ ...config, webDir }, db);
          try {
            for (let i = 0; i < 320; i++)
              assert.equal(
                (await bounded.app.inject({ url: "/" })).statusCode,
                200,
              );
            for (let i = 0; i < 300; i++)
              assert.equal(
                (await bounded.app.inject({ url: "/api/health" })).statusCode,
                200,
              );
            const limited = await bounded.app.inject({ url: "/api/health" });
            assert.equal(limited.statusCode, 429, limited.body);
            assert.equal(limited.json().error.code, "RATE_LIMIT");
            assert.ok(Number(limited.headers["retry-after"]) > 0);
            assert.equal(
              (await bounded.app.inject({ url: "/" })).statusCode,
              200,
            );
          } finally {
            await bounded.app.close();
          }
        },
      );
      await t.test(
        "F9: narrowly trusted forwarding separates clients; spoofed headers cannot reset limits",
        async () => {
          assert.throws(() => parseTrustedProxies("0.0.0.0/0"));
          assert.throws(() => parseTrustedProxies("::/0"));
          assert.throws(() => parseTrustedProxies("true"));
          const direct = await createApp({ ...config, trustProxy: [] }, db),
            trusted = await createApp(
              { ...config, trustProxy: ["127.0.0.1/32"] },
              db,
            );
          const login = {
            email: "absent@example.invalid",
            password: "incorrect-password-long",
          };
          try {
            for (let i = 0; i < 10; i++)
              assert.equal(
                (
                  await direct.app.inject({
                    method: "POST",
                    url: "/api/auth/login",
                    remoteAddress: "203.0.113.9",
                    headers: { "x-forwarded-for": `198.51.100.${i}` },
                    payload: login,
                  })
                ).statusCode,
                401,
              );
            const authLimited = await direct.app.inject({
              method: "POST",
              url: "/api/auth/login",
              remoteAddress: "203.0.113.9",
              headers: { "x-forwarded-for": "192.0.2.99" },
              payload: login,
            });
            assert.equal(authLimited.statusCode, 429);
            assert.equal(authLimited.json().error.code, "RATE_LIMIT");
            assert.ok(Number(authLimited.headers["retry-after"]) > 0);
            for (let i = 0; i < 10; i++)
              assert.equal(
                (
                  await trusted.app.inject({
                    method: "POST",
                    url: "/api/auth/login",
                    remoteAddress: "127.0.0.1",
                    headers: { "x-forwarded-for": "198.51.100.1" },
                    payload: login,
                  })
                ).statusCode,
                401,
              );
            assert.equal(
              (
                await trusted.app.inject({
                  method: "POST",
                  url: "/api/auth/login",
                  remoteAddress: "127.0.0.1",
                  headers: { "x-forwarded-for": "198.51.100.2" },
                  payload: login,
                })
              ).statusCode,
              401,
            );
            assert.equal(
              (
                await trusted.app.inject({
                  method: "POST",
                  url: "/api/auth/login",
                  remoteAddress: "127.0.0.1",
                  headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.1" },
                  payload: login,
                })
              ).statusCode,
              429,
            );
            for (let i = 0; i < 10; i++)
              assert.equal(
                (
                  await trusted.app.inject({
                    method: "POST",
                    url: "/api/auth/login",
                    remoteAddress: "203.0.113.9",
                    headers: { "x-forwarded-for": `192.0.2.${i}` },
                    payload: login,
                  })
                ).statusCode,
                401,
              );
            assert.equal(
              (
                await trusted.app.inject({
                  method: "POST",
                  url: "/api/auth/login",
                  remoteAddress: "203.0.113.9",
                  headers: { "x-forwarded-for": "198.51.100.99" },
                  payload: login,
                })
              ).statusCode,
              429,
            );
            await trusted.app.listen({ host: "127.0.0.1", port: 0 });
            const appPort = (trusted.app.server.address() as net.AddressInfo)
              .port;
            const proxy = http.createServer((incoming, outgoing) => {
              const forwarded = [
                incoming.headers["x-forwarded-for"],
                incoming.socket.remoteAddress,
              ]
                .filter(Boolean)
                .join(", ");
              const untrustedPeer = incoming.url?.startsWith("/untrusted/");
              const upstreamRequest = http.request(
                {
                  host: "127.0.0.1",
                  localAddress: untrustedPeer ? "127.0.0.4" : "127.0.0.1",
                  port: appPort,
                  path: untrustedPeer
                    ? incoming.url!.slice("/untrusted".length)
                    : incoming.url,
                  method: incoming.method,
                  headers: {
                    ...incoming.headers,
                    "x-forwarded-for": forwarded,
                  },
                },
                (response) => {
                  outgoing.writeHead(response.statusCode!, response.headers);
                  response.pipe(outgoing);
                },
              );
              upstreamRequest.on("error", () => outgoing.writeHead(502).end());
              incoming.pipe(upstreamRequest);
            });
            proxy.listen(0, "127.0.0.1");
            await once(proxy, "listening");
            const viaProxy = (
              localAddress: string,
              spoof?: string,
              untrustedPeer = false,
            ) =>
              new Promise<number>((resolve, reject) => {
                const payload = JSON.stringify(login);
                const call = http.request(
                  {
                    host: "127.0.0.1",
                    port: (proxy.address() as net.AddressInfo).port,
                    localAddress,
                    path: untrustedPeer
                      ? "/untrusted/api/auth/login"
                      : "/api/auth/login",
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(payload),
                      ...(spoof ? { "x-forwarded-for": spoof } : {}),
                    },
                  },
                  (response) => {
                    response.resume();
                    response.on("end", () => resolve(response.statusCode!));
                  },
                );
                call.on("error", reject);
                call.end(payload);
              });
            try {
              for (let i = 0; i < 10; i++)
                assert.equal(await viaProxy("127.0.0.2"), 401);
              assert.equal(await viaProxy("127.0.0.2", "192.0.2.123"), 429);
              assert.equal(await viaProxy("127.0.0.3"), 401);
              for (let i = 0; i < 10; i++)
                assert.equal(
                  await viaProxy("127.0.0.3", `192.0.2.${i}`, true),
                  401,
                );
              assert.equal(
                await viaProxy("127.0.0.3", "198.51.100.254", true),
                429,
              );
            } finally {
              proxy.closeAllConnections();
              proxy.close();
              await once(proxy, "close");
            }
          } finally {
            await direct.app.close();
            await trusted.app.close();
          }
        },
      );
    } finally {
      for (const response of held) response.destroy();
      upstream.closeAllConnections();
      upstream.close();
      await once(upstream, "close");
      await ctx.app.close();
      for (const owner of owners) await db`DELETE FROM users WHERE id=${owner}`;
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
