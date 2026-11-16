import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import * as cheerio from "cheerio";
import { createApp } from "../src/app.js";
import { type Config, connect, migrate } from "../src/core.js";
import { readZip, makeZip } from "../src/zip.js";
import { upstreamFixture } from "./fixture.js";

test(
  "PostgreSQL API: tenant isolation, durable archives, imports, OPML, EPUB and scheduling",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 180000 },
  async (t) => {
    const fixture = await upstreamFixture(),
      dataDir = await mkdtemp(join(tmpdir(), "feedink-api-test-"));
    const config: Config = {
      databaseUrl: process.env.TEST_DATABASE_URL!,
      dataDir,
      appUrl: "http://localhost:3000",
      sessionSecret: "integration-test-secret-32-characters-minimum",
      host: "127.0.0.1",
      port: 0,
      registration: true,
      adminEmail: "",
      fetchAllowHosts: ["127.0.0.1"],
      webDir: join(dataDir, "no-web"),
      worker: false,
    };
    const db = connect(config);
    await Promise.all([migrate(db), migrate(db)]);
    const context = await createApp(config, db),
      { app } = context,
      ownedUsers: string[] = [];
    const request = async (
      method: string,
      path: string,
      body?: unknown,
      session?: { cookie: string; csrf: string },
      extra: Record<string, string> = {},
    ) =>
      app.inject({
        method: method as any,
        url: "/api" + path,
        payload: body as any,
        headers: {
          ...(session
            ? { cookie: session.cookie, "x-csrf-token": session.csrf }
            : {}),
          ...extra,
        },
      });
    const register = async () => {
      const response = await request("POST", "/auth/register", {
        email: `test-${randomUUID()}@example.invalid`,
        password: "test-password-long",
        name: "Test reader",
      });
      assert.equal(response.statusCode, 201, response.body);
      const json = response.json();
      ownedUsers.push(json.user.id);
      return {
        id: json.user.id,
        email: json.user.email,
        cookie: String(response.headers["set-cookie"]).split(";")[0],
        csrf: json.csrfToken,
      };
    };
    const multipart = (bytes: Buffer) => ({
      body: Buffer.concat([
        Buffer.from(
          '--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n',
        ),
        bytes,
        Buffer.from("\r\n--test-boundary--\r\n"),
      ]),
      headers: {
        "content-type": "multipart/form-data; boundary=test-boundary",
      },
    });
    try {
      const a = await register(),
        b = await register();
      await t.test(
        "sessions, CSRF, foreign origins and account updates",
        async () => {
          assert.equal((await request("GET", "/health")).statusCode, 200);
          assert.equal((await request("GET", "/session")).statusCode, 401);
          assert.equal(
            (await request("GET", "/session", undefined, a)).json().user.id,
            a.id,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/folders",
                { name: "No CSRF" },
                { ...a, csrf: "" },
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request("POST", "/folders", { name: "Foreign" }, a, {
                origin: "https://attacker.invalid",
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/auth/login",
                { email: "test@example.invalid", password: "long-password" },
                undefined,
                { origin: "https://attacker.invalid" },
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (await request("GET", "/admin/users", undefined, a)).statusCode,
            403,
          );
          const updated = await request(
            "PATCH",
            "/account",
            { name: "Updated reader" },
            a,
          );
          assert.equal(updated.json().name, "Updated reader");
        },
      );
      let subscription: any, article: any, folder: any, tag: any;
      await t.test(
        "discover, initial ingestion, relative/lazy/srcset images and conditional refresh",
        async () => {
          const discovery = await request(
            "GET",
            `/discover?q=${encodeURIComponent(fixture.base + "/page")}`,
            undefined,
            a,
          );
          assert.equal(discovery.statusCode, 200, discovery.body);
          assert.equal(discovery.json().feeds[0].url, fixture.base + "/feed");
          folder = (
            await request("POST", "/folders", { name: "阅读 / 测试" }, a)
          ).json();
          const result = await request(
            "POST",
            "/subscriptions",
            { url: fixture.base + "/page", folderId: folder.id },
            a,
          );
          assert.equal(result.statusCode, 201, result.body);
          subscription = result.json();
          assert.equal(subscription.status, "ok", JSON.stringify(subscription));
          assert.equal(subscription.totalCount, 2);
          const list = (
            await request(
              "GET",
              "/articles?q=" + encodeURIComponent("中文归档"),
              undefined,
              a,
            )
          ).json();
          assert.equal(list.items.length, 1, JSON.stringify(list));
          article = (
            await request("GET", `/articles/${list.items[0].id}`, undefined, a)
          ).json();
          assert.equal(article.read, false);
          assert.equal(
            article.images.filter((i: any) => i.status === "cached").length,
            2,
            JSON.stringify(article.images),
          );
          assert.equal(
            article.images.filter((i: any) => i.status === "failed").length,
            1,
          );
          assert.ok(fixture.referers > 0);
          assert.ok(!article.contentHtml.includes("script"));
          assert.ok(!article.contentHtml.includes("onerror"));
          assert.ok(
            article.images.some((i: any) =>
              i.originalUrl.endsWith("/large.png"),
            ),
          );
          const refreshed = await request(
            "POST",
            `/subscriptions/${subscription.id}/refresh`,
            {},
            a,
          );
          assert.equal(refreshed.json().status, "ok");
          assert.equal(fixture.conditionals, 1);
        },
      );
      await t.test(
        "tenant-owned article/assets/state/folders/ebooks; no implicit read",
        async () => {
          const image = article.images.find((i: any) => i.status === "cached");
          assert.equal(
            (await request("GET", image.url.replace("/api", ""))).statusCode,
            401,
          );
          assert.equal(
            (await request("GET", image.url.replace("/api", ""), undefined, b))
              .statusCode,
            404,
          );
          const bytes = await request(
            "GET",
            image.url.replace("/api", ""),
            undefined,
            a,
          );
          assert.equal(bytes.statusCode, 200);
          assert.equal(bytes.headers["content-type"], "image/png");
          assert.equal(
            (await request("GET", `/articles/${article.id}`, undefined, b))
              .statusCode,
            404,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                `/articles/${article.id}/state`,
                { read: true },
                b,
              )
            ).statusCode,
            404,
          );
          assert.equal(
            (await request("POST", "/ebooks", { articleIds: [article.id] }, b))
              .statusCode,
            404,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                `/folders/${folder.id}`,
                { name: "stolen" },
                b,
              )
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await request("GET", `/articles/${article.id}`, undefined, a)
            ).json().read,
            false,
          );
        },
      );
      await t.test(
        "stable tied cursors, Chinese search, tags and exact bulk filters",
        async () => {
          const first = (
              await request("GET", "/articles?limit=1", undefined, a)
            ).json(),
            second = (
              await request(
                "GET",
                `/articles?limit=1&cursor=${first.nextCursor}`,
                undefined,
                a,
              )
            ).json();
          assert.notEqual(first.items[0].id, second.items[0].id);
          assert.equal(second.nextCursor, null);
          tag = (
            await request(
              "POST",
              "/tags",
              { name: "收藏研究", color: "#123456" },
              a,
            )
          ).json();
          let state = await request(
            "PATCH",
            `/articles/${article.id}/state`,
            { saved: true, progress: 0.5, tagIds: [tag.id] },
            a,
          );
          assert.equal(state.json().tags[0].id, tag.id);
          const bulk = await request(
            "POST",
            "/articles/bulk-state",
            { query: { tagId: tag.id }, read: true },
            a,
          );
          assert.equal(bulk.json().updated, 1);
          assert.equal(
            (
              await request("GET", "/articles?scope=unread", undefined, a)
            ).json().total,
            1,
          );
          assert.equal(
            (
              await request(
                "GET",
                `/articles?folderId=${folder.id}`,
                undefined,
                a,
              )
            ).json().total,
            2,
          );
          assert.equal(
            (await request("GET", "/tags", undefined, a)).json().items[0].count,
            1,
          );
        },
      );
      await t.test(
        "RSS sliding windows do not erase prior body and fulltext is a separate snapshot",
        async () => {
          fixture.omitOldArticle();
          assert.equal(
            (
              await request(
                "POST",
                `/subscriptions/${subscription.id}/refresh`,
                {},
                a,
              )
            ).json().totalCount,
            2,
          );
          const full = await request(
            "POST",
            `/articles/${article.id}/fulltext`,
            {},
            a,
          );
          assert.equal(full.statusCode, 200, full.body);
          assert.match(full.json().fulltextHtml, /original full text/);
          assert.equal(full.json().contentHtml, article.contentHtml);
          assert.equal(full.json().fulltextError, null);
          const saved = await request(
            "POST",
            "/articles/save-url",
            { url: fixture.base + "/saved" },
            a,
          );
          assert.equal(saved.statusCode, 201, saved.body);
          assert.equal(saved.json().title, "完整文章标题");
          assert.equal(saved.json().saved, true);
        },
      );
      await t.test(
        "Atom, JSON Feed, OPML groups and XML entity denial",
        async () => {
          for (const format of ["atom", "json"]) {
            const result = await request(
              "POST",
              "/subscriptions",
              { url: fixture.base + "/" + format },
              a,
            );
            assert.equal(result.statusCode, 201, result.body);
            assert.equal(result.json().totalCount, 1);
          }
          const exported = await request("GET", "/export/opml", undefined, a);
          assert.match(exported.body, /阅读 \/ 测试/);
          const imported = await request(
            "POST",
            "/import/opml",
            { content: exported.body },
            b,
          );
          assert.equal(imported.statusCode, 200, imported.body);
          assert.equal(imported.json().imported, 3);
          const denied = await request(
            "POST",
            "/import/opml",
            {
              content:
                '<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml><body/></opml>',
            },
            a,
          );
          assert.equal(denied.statusCode, 400);
          const redirect = await request(
            "GET",
            `/discover?q=${encodeURIComponent(fixture.base + "/redirect")}`,
            undefined,
            a,
          );
          assert.equal(redirect.statusCode, 400, redirect.body);
        },
      );
      let archived: Buffer;
      await t.test(
        "offline source plus unsubscribe preserve original body, fulltext and image bytes",
        async () => {
          fixture.offline();
          const failed = await request(
            "POST",
            `/subscriptions/${subscription.id}/refresh`,
            {},
            a,
          );
          assert.equal(failed.json().status, "error");
          assert.match(failed.json().lastError, /HTTP 503/);
          const [backoff] =
            await db`SELECT failures,next_fetch_at FROM feeds WHERE id=${subscription.feedId}`;
          assert.equal(backoff.failures, 1);
          assert.ok(new Date(backoff.next_fetch_at).getTime() > Date.now());
          assert.equal(
            (
              await request(
                "DELETE",
                `/subscriptions/${subscription.id}`,
                undefined,
                a,
              )
            ).statusCode,
            204,
          );
          const detail = await request(
            "GET",
            `/articles/${article.id}`,
            undefined,
            a,
          );
          assert.equal(detail.statusCode, 200);
          assert.equal(detail.json().title, article.title);
          assert.equal(detail.json().url, fixture.base + "/article");
          assert.match(detail.json().fulltextHtml, /original full text/);
          assert.equal(detail.json().subscriptionId, null);
          assert.ok(
            (await request("GET", "/articles?scope=archive", undefined, a))
              .json()
              .items.some((i: any) => i.id === article.id),
          );
          const image = detail
            .json()
            .images.find((i: any) => i.status === "cached");
          assert.equal(
            (await request("GET", image.url.replace("/api", ""), undefined, a))
              .statusCode,
            200,
          );
          const exported = await request(
            "GET",
            "/export/archive",
            undefined,
            a,
          );
          assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
          archived = exported.rawPayload;
          const entries = await readZip(archived);
          assert.ok(entries.has("manifest.json"));
          assert.ok(entries.size > 1);
        },
      );
      await t.test(
        "ZIP restores into new owned IDs offline and rejects unknown/symlink-like files",
        async () => {
          const c = await register(),
            upload = multipart(archived!);
          const imported = await request(
            "POST",
            "/import/archive",
            upload.body,
            c,
            upload.headers,
          );
          assert.equal(imported.statusCode, 200, imported.body);
          assert.equal(imported.json().imported, 5);
          const page = (
            await request(
              "GET",
              "/articles?scope=archive&q=" + encodeURIComponent("中文归档"),
              undefined,
              c,
            )
          ).json();
          assert.equal(page.total, 1);
          assert.notEqual(page.items[0].id, article.id);
          const restored = (
            await request("GET", `/articles/${page.items[0].id}`, undefined, c)
          ).json();
          assert.match(restored.fulltextHtml, /original full text/);
          const img = restored.images.find((i: any) => i.status === "cached");
          assert.notEqual(img.id, article.images[0].id);
          assert.equal(
            (await request("GET", img.url.replace("/api", ""), undefined, c))
              .statusCode,
            200,
          );
          assert.equal(
            (await request("GET", img.url.replace("/api", ""), undefined, a))
              .statusCode,
            404,
          );
          const repeat = await request(
            "POST",
            "/import/archive",
            upload.body,
            c,
            upload.headers,
          );
          assert.equal(repeat.json().skipped, 5);
          const entries = await readZip(archived!);
          const bad = await makeZip(
            [...entries]
              .map(([name, data]) => ({ name, data }))
              .concat([
                { name: "unexpected.html", data: Buffer.from("<script/>") },
              ]),
          );
          const badUpload = multipart(bad);
          assert.equal(
            (
              await request(
                "POST",
                "/import/archive",
                badUpload.body,
                c,
                badUpload.headers,
              )
            ).statusCode,
            422,
          );
        },
      );
      await t.test(
        "EPUB3 contains XML package/navigation and local archived image files",
        async () => {
          const created = await request(
            "POST",
            "/ebooks",
            { articleIds: [article.id], title: "离线阅读集" },
            a,
          );
          assert.equal(created.statusCode, 201, created.body);
          const ebook = created.json(),
            download = await request(
              "GET",
              ebook.downloadUrl.replace("/api", ""),
              undefined,
              a,
            );
          assert.equal(download.statusCode, 200);
          const files = await readZip(download.rawPayload);
          assert.equal(
            files.get("mimetype")?.toString(),
            "application/epub+zip",
          );
          assert.ok(files.has("META-INF/container.xml"));
          const opf = cheerio.load(files.get("OEBPS/package.opf")!.toString(), {
            xml: true,
          });
          assert.equal(opf("package").attr("version"), "3.0");
          assert.ok(opf("manifest item").length >= 3);
          for (const [name, bytes] of files)
            if (/\.(xhtml|xml|opf)$/.test(name)) {
              const document = new JSDOM(bytes.toString(), {
                contentType: "application/xml",
              });
              document.window.close();
            }
          assert.equal(download.rawPayload.readUInt16LE(8), 0);
          assert.match(
            files.get("OEBPS/article-0.xhtml")!.toString(),
            /images\//,
          );
          assert.equal(
            (
              await request(
                "GET",
                ebook.downloadUrl.replace("/api", ""),
                undefined,
                b,
              )
            ).statusCode,
            404,
          );
          delete process.env.SMTP_HOST;
          delete process.env.SMTP_FROM;
          const sending = await request(
            "POST",
            "/ebooks",
            { articleIds: [article.id], send: true },
            a,
          );
          assert.equal(sending.statusCode, 503, sending.body);
          assert.equal(sending.json().error.code, "SMTP_UNCONFIGURED");
          assert.ok(
            (await request("GET", "/ebooks", undefined, a))
              .json()
              .items.some((e: any) => e.error?.includes("SMTP_HOST")),
          );
        },
      );
      await t.test(
        "SMTP fixture receives one scheduled message with durable deduplication",
        async () => {
          let messages = 0;
          const sockets = new Set<import("node:net").Socket>();
          const smtp = createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.write("220 fixture ESMTP\r\n");
            let buffer = "",
              data = false;
            socket.on("data", (chunk) => {
              buffer += chunk.toString();
              while (buffer.includes("\r\n")) {
                const index = buffer.indexOf("\r\n"),
                  line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (data) {
                  if (line === ".") {
                    data = false;
                    messages++;
                    socket.write("250 accepted\r\n");
                  }
                  continue;
                }
                if (/^EHLO|HELO/.test(line)) socket.write("250 fixture\r\n");
                else if (/^MAIL|RCPT/.test(line)) socket.write("250 ok\r\n");
                else if (line === "DATA") {
                  data = true;
                  socket.write("354 continue\r\n");
                } else if (line === "QUIT") {
                  socket.end("221 bye\r\n");
                } else socket.write("250 ok\r\n");
              }
            });
          });
          smtp.listen(0, "127.0.0.1");
          await once(smtp, "listening");
          process.env.SMTP_HOST = "127.0.0.1";
          process.env.SMTP_PORT = String((smtp.address() as any).port);
          process.env.SMTP_FROM = "fixture@example.invalid";
          try {
            await request(
              "PATCH",
              "/settings",
              {
                ebookAutoSend: true,
                ebookEmail: "reader@example.invalid",
                ebookHour: 0,
                ebookMinArticles: 1,
                ebookMaxArticles: 10,
              },
              a,
            );
            await context.ebooks.schedules(new Date("2026-06-10T12:00:00Z"));
            await context.ebooks.schedules(new Date("2026-06-10T12:01:00Z"));
            assert.equal(messages, 1);
            const jobs =
              await db`SELECT * FROM ebooks WHERE user_id=${a.id} AND schedule_key IS NOT NULL`;
            assert.equal(jobs.length, 1);
            assert.ok(jobs[0].sent_at);
            assert.equal(jobs[0].error, null);
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
        "cursor retains PostgreSQL microseconds and rejects malformed opaque IDs",
        async () => {
          const [other] =
            await db`SELECT id FROM articles WHERE user_id=${a.id} AND id!=${article.id} LIMIT 1`;
          await db`UPDATE articles SET published_at='2026-01-01T00:00:00.123001Z' WHERE id=${article.id}`;
          await db`UPDATE articles SET published_at='2026-01-01T00:00:00.123999Z' WHERE id=${other.id}`;
          const first = (
            await request(
              "GET",
              "/articles?scope=archive&sort=oldest&limit=1",
              undefined,
              a,
            )
          ).json();
          assert.equal(first.items[0].id, article.id);
          const second = (
            await request(
              "GET",
              `/articles?scope=archive&sort=oldest&limit=1&cursor=${first.nextCursor}`,
              undefined,
              a,
            )
          ).json();
          assert.equal(second.items[0].id, other.id);
          const invalid = Buffer.from(
            JSON.stringify({
              date: "2026-01-01T00:00:00Z",
              id: "-".repeat(36),
            }),
          ).toString("base64url");
          assert.equal(
            (await request("GET", `/articles?cursor=${invalid}`, undefined, a))
              .statusCode,
            400,
          );
        },
      );
      await t.test(
        "production-style static shell and SPA routes are served without exposing protected API",
        async () => {
          const webDir = join(dataDir, "web-fixture");
          await mkdir(webDir);
          await writeFile(
            join(webDir, "index.html"),
            "<!doctype html><title>FeedInk shell fixture</title>",
          );
          const web = await createApp({ ...config, webDir }, db);
          try {
            await web.app.listen({ host: "127.0.0.1", port: 0 });
            const address = web.app.server.address() as any;
            const response = await fetch(
              `http://127.0.0.1:${address.port}/settings`,
            );
            assert.equal(response.status, 200);
            assert.match(await response.text(), /FeedInk shell fixture/);
            assert.match(
              response.headers.get("content-security-policy") || "",
              /script-src 'self'/,
            );
            const root = await web.app.inject({ url: "/" });
            assert.equal(root.statusCode, 200);
            assert.match(
              String(root.headers["content-security-policy"]),
              /script-src 'self'/,
            );
            assert.equal(
              (await web.app.inject({ url: "/api/articles" })).statusCode,
              401,
            );
          } finally {
            await web.app.close();
          }
        },
      );
      await t.test(
        "password changes revoke other sessions; admin disable revokes sessions and protects self",
        async () => {
          const login = await request("POST", "/auth/login", {
            email: a.email,
            password: "test-password-long",
          });
          assert.equal(login.statusCode, 200);
          const otherSession = {
            cookie: String(login.headers["set-cookie"]).split(";")[0],
            csrf: login.json().csrfToken,
          };
          assert.equal(
            (
              await request(
                "PATCH",
                "/account",
                {
                  currentPassword: "incorrect-password",
                  password: "new-test-password-long",
                },
                a,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                "/account",
                {
                  currentPassword: "test-password-long",
                  password: "new-test-password-long",
                },
                a,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (await request("GET", "/session", undefined, otherSession))
              .statusCode,
            401,
          );
          assert.equal(
            (await request("GET", "/session", undefined, a)).statusCode,
            200,
          );
          await db`UPDATE users SET is_admin=true WHERE id=${a.id}`;
          const users = await request("GET", "/admin/users", undefined, a);
          assert.equal(users.statusCode, 200);
          assert.ok(!users.body.includes("password_hash"));
          assert.ok(!users.body.includes("token_hash"));
          assert.equal(
            (
              await request(
                "PATCH",
                `/admin/users/${a.id}`,
                { disabled: true },
                a,
              )
            ).statusCode,
            409,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                `/admin/users/${b.id}`,
                { disabled: true },
                a,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (await request("GET", "/session", undefined, b)).statusCode,
            401,
          );
          assert.equal(
            (
              await request("POST", "/auth/login", {
                email: b.email,
                password: "test-password-long",
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                `/admin/users/${b.id}`,
                { disabled: false },
                a,
              )
            ).statusCode,
            200,
          );
        },
      );
      await t.test(
        "failed scheduled jobs stay visible and deduplicated across subsequent ticks",
        async () => {
          const newId = randomUUID();
          await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) SELECT ${newId},a.user_id,a.feed_id,${newId},a.feed_title,'New active article',a.url,now(),'<p>Unsent active article</p>','Unsent active article','fixture' FROM articles a JOIN subscriptions s ON s.feed_id=a.feed_id WHERE a.user_id=${a.id} LIMIT 1`;
          await context.ebooks.schedules(new Date("2026-06-11T12:00:00Z"));
          await context.ebooks.schedules(new Date("2026-06-11T12:01:00Z"));
          const jobs =
            await db`SELECT * FROM ebooks WHERE user_id=${a.id} AND schedule_key IS NOT NULL AND sent_at IS NULL`;
          assert.equal(jobs.length, 1);
          assert.match(jobs[0].error, /SMTP_HOST/);
        },
      );
      await t.test(
        "independent first-party demo, local generated images, safe outbound quotas, no mail or admin",
        async () => {
          const r = await request("POST", "/auth/demo", {});
          assert.equal(r.statusCode, 201, r.body);
          const session = r.json(),
            demo = {
              cookie: String(r.headers["set-cookie"]).split(";")[0],
              csrf: session.csrfToken,
            };
          ownedUsers.push(session.user.id);
          assert.equal(session.user.isDemo, true);
          const page = (
            await request("GET", "/articles", undefined, demo)
          ).json();
          assert.equal(page.total, 20);
          const item = page.items[0];
          assert.equal(
            (await request("GET", `/articles/${item.id}`, undefined, a))
              .statusCode,
            404,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/ebooks",
                { articleIds: [item.id], send: true },
                demo,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (await request("GET", "/admin/users", undefined, demo)).statusCode,
            403,
          );
          assert.equal(
            (
              await request("POST", `/articles/${item.id}/fulltext`, {}, demo)
            ).json().fulltextHtml.length > 0,
            true,
          );
          fixture.online();
          const added = await request(
            "POST",
            "/subscriptions",
            { url: fixture.base + "/json" },
            demo,
          );
          assert.equal(added.statusCode, 201, added.body);
          assert.equal(added.json().status, "ok");
          for (let i = 0; i < 9; i++)
            assert.equal(
              (
                await request(
                  "GET",
                  `/discover?q=${encodeURIComponent(fixture.base + "/feed")}`,
                  undefined,
                  demo,
                )
              ).statusCode,
              200,
            );
          const limited = await request(
            "GET",
            `/discover?q=${encodeURIComponent(fixture.base + "/feed")}`,
            undefined,
            demo,
          );
          assert.equal(limited.statusCode, 429, limited.body);
          assert.equal(limited.json().error.code, "DEMO_QUOTA");
          assert.equal(
            (await request("POST", "/auth/logout", {}, demo)).statusCode,
            204,
          );
          assert.equal(
            (await request("GET", "/session", undefined, demo)).statusCode,
            401,
          );
        },
      );
    } finally {
      try {
        await app.close();
        for (const userId of ownedUsers)
          await db`DELETE FROM users WHERE id=${userId}`;
      } finally {
        try { await db.end({ timeout: 5 }); }
        finally {
          try { await fixture.close(); }
          finally { await rm(dataDir, { recursive: true, force: true }); }
        }
      }
    }
  },
);
