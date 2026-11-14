import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { stat } from "node:fs/promises";
import { z, ZodError } from "zod";
import { API_VERSION } from "@feedink/shared";
import {
  type Config,
  type DB,
  type Row,
  Store,
  connect,
  migrate,
  id,
  hash,
  ApiFailure,
  withConnection,
  parseTrustedProxies,
} from "./core.js";
import { SafeFetcher } from "./network.js";
import { Content } from "./content.js";
import { Feeds } from "./feeds.js";
import { Articles } from "./articles.js";
import { Archives } from "./archive.js";
import { Ebooks, ebookDto } from "./ebooks.js";
import { Auth } from "./auth.js";
import { seedDemo } from "./demo.js";
import {
  uuid,
  name,
  url,
  color,
  preferences,
  articleQuery,
  statePatch,
} from "./validation.js";
import { ZIP_LIMIT } from "./zip.js";

export async function createApp(config: Config, providedDb?: DB) {
  const db = providedDb || connect(config);
  await migrate(db);
  const store = new Store(config.dataDir);
  await store.init();
  await withConnection(db, (sql) => store.recover(sql));
  const fetcher = new SafeFetcher(config.fetchAllowHosts),
    content = new Content(db, store, fetcher),
    feeds = new Feeds(db, fetcher, content),
    articles = new Articles(db),
    archives = new Archives(db, store, articles),
    ebooks = new Ebooks(db, store);
  const app = Fastify({
    logger:
      process.env.NODE_ENV !== "test"
        ? {
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "req.headers.x-csrf-token",
            ],
          }
        : false,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 120000,
    trustProxy: config.trustProxy?.length
      ? parseTrustedProxies(config.trustProxy.join(","))
      : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    cache: 10000,
    allowList: (request) => !request.url.startsWith("/api/"),
    errorResponseBuilder: () =>
      new ApiFailure(429, "RATE_LIMIT", "Too many requests; retry later"),
  });
  await app.register(multipart, {
    limits: { fileSize: ZIP_LIMIT, files: 1, fields: 0, parts: 1 },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: "VALIDATION",
          message: "Invalid request",
          details: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        },
      });
      return;
    }
    if (error instanceof ApiFailure) {
      reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    const err = error as any;
    if (err.code === "23505") {
      reply.code(409).send({
        error: { code: "CONFLICT", message: "This record already exists" },
      });
      return;
    }
    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode).send({
        error: {
          code: err.statusCode === 413 ? "BODY_LIMIT" : "BAD_REQUEST",
          message:
            err.statusCode === 413
              ? "Request exceeds the size limit"
              : "Invalid request",
        },
      });
      return;
    }
    request.log.error(
      { err: { name: err.name, code: err.code } },
      "Request failed",
    );
    reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
  app.addHook("onSend", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (
      !request.url.startsWith("/api/") &&
      String(reply.getHeader("content-type") || "").includes("text/html")
    )
      reply
        .header("Cache-Control", "no-cache")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' https: http: blob:; connect-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        );
  });
  new Auth(db, config).install(app, (user) =>
    seedDemo(db, store, config, user),
  );
  const param = (request: { params: unknown }) =>
    uuid.parse((request.params as any).id);
  const user = (request: { account: Row | null }) =>
    request.account!.id as string;
  const demoOutbound = async (request: { account: Row | null }) => {
    if (!request.account!.is_demo) return;
    const bucket = Math.floor(Date.now() / 300000),
      userId = user(request);
    const rows =
      await db`INSERT INTO demo_outbound_usage(user_id,bucket) VALUES(${userId},${bucket}) ON CONFLICT(user_id,bucket) DO UPDATE SET attempts=demo_outbound_usage.attempts+1 WHERE demo_outbound_usage.attempts<10 RETURNING attempts`;
    if (!rows.length)
      throw new ApiFailure(
        429,
        "DEMO_QUOTA",
        "Demo allows 10 external fetch operations per five minutes; wait or register your own account",
      );
  };
  const outboundLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  app.get("/api/health", async () => {
    await db`SELECT 1`;
    return { status: "ok", version: API_VERSION, database: "ok" };
  });
  app.get("/api/subscriptions", async (request) => ({
    items: await feeds.subscriptions(user(request)),
  }));
  app.post(
    "/api/subscriptions",
    { config: outboundLimit },
    async (request, reply) => {
      await demoOutbound(request);
      const input = z
        .object({
          url,
          title: name.optional(),
          folderId: uuid.nullable().optional(),
        })
        .strict()
        .parse(request.body);
      const result = await feeds.subscribe(user(request), input);
      reply.code(201);
      return result;
    },
  );
  app.patch("/api/subscriptions/:id", async (request) => {
    const input = z
        .object({
          title: name.optional(),
          folderId: uuid.nullable().optional(),
          position: z.number().int().min(-100000).max(100000).optional(),
          settings: preferences.optional(),
        })
        .strict()
        .parse(request.body),
      subscriptionId = param(request),
      userId = user(request);
    const [existing] =
      await db`SELECT * FROM subscriptions WHERE id=${subscriptionId} AND user_id=${userId}`;
    if (!existing)
      throw new ApiFailure(404, "NOT_FOUND", "Subscription not found");
    if (
      input.folderId &&
      !(
        await db`SELECT id FROM folders WHERE id=${input.folderId} AND user_id=${userId}`
      ).length
    )
      throw new ApiFailure(404, "NOT_FOUND", "Folder not found");
    await db`UPDATE subscriptions SET title=${input.title ?? existing.title},folder_id=${input.folderId === undefined ? existing.folder_id : input.folderId},position=${input.position ?? existing.position},settings=${db.json({ ...existing.settings, ...input.settings })} WHERE id=${subscriptionId}`;
    return (await feeds.subscriptions(userId)).find(
      (s) => s.id === subscriptionId,
    );
  });
  app.delete("/api/subscriptions/:id", async (request, reply) => {
    const rows =
      await db`DELETE FROM subscriptions WHERE id=${param(request)} AND user_id=${user(request)} RETURNING id`;
    if (!rows.length)
      throw new ApiFailure(404, "NOT_FOUND", "Subscription not found");
    reply.code(204).send();
  });
  app.post(
    "/api/subscriptions/:id/refresh",
    { config: outboundLimit },
    async (request) => {
      await demoOutbound(request);
      const subscriptionId = param(request),
        userId = user(request);
      const [feed] =
        await db`SELECT f.* FROM feeds f JOIN subscriptions s ON s.feed_id=f.id WHERE s.id=${subscriptionId} AND s.user_id=${userId}`;
      if (!feed)
        throw new ApiFailure(404, "NOT_FOUND", "Subscription not found");
      await feeds.refresh(feed);
      return (await feeds.subscriptions(userId)).find(
        (s) => s.id === subscriptionId,
      );
    },
  );
  app.get("/api/discover", { config: outboundLimit }, async (request) => {
    const input = z
      .object({
        q: z.string().max(4096).default(""),
        topic: z.string().max(100).default(""),
      })
      .strict()
      .parse(request.query);
    if (/^(https?|rsshub):/i.test(input.q)) await demoOutbound(request);
    return { feeds: await feeds.discover(input.q, input.topic) };
  });
  const folderList = async (userId: string) => {
    const rows =
      await db`SELECT f.*,(SELECT count(*)::integer FROM articles a JOIN subscriptions s ON s.feed_id=a.feed_id WHERE s.folder_id=f.id AND NOT a.read) AS unread_count FROM folders f WHERE f.user_id=${userId} ORDER BY f.position,f.name`;
    return rows.map((f) => ({
      id: f.id,
      name: f.name,
      position: f.position,
      settings: f.settings,
      unreadCount: f.unread_count,
    }));
  };
  app.get("/api/folders", async (request) => ({
    items: await folderList(user(request)),
  }));
  app.post("/api/folders", async (request, reply) => {
    const input = z.object({ name }).strict().parse(request.body),
      folderId = id();
    await db`INSERT INTO folders(id,user_id,name) VALUES(${folderId},${user(request)},${input.name})`;
    reply.code(201);
    return (await folderList(user(request))).find((f) => f.id === folderId);
  });
  app.patch("/api/folders/:id", async (request) => {
    const input = z
        .object({
          name: name.optional(),
          position: z.number().int().min(-100000).max(100000).optional(),
          settings: preferences.optional(),
        })
        .strict()
        .parse(request.body),
      folderId = param(request);
    const [existing] =
      await db`SELECT * FROM folders WHERE id=${folderId} AND user_id=${user(request)}`;
    if (!existing) throw new ApiFailure(404, "NOT_FOUND", "Folder not found");
    await db`UPDATE folders SET name=${input.name ?? existing.name},position=${input.position ?? existing.position},settings=${db.json({ ...existing.settings, ...input.settings })} WHERE id=${folderId}`;
    return (await folderList(user(request))).find((f) => f.id === folderId);
  });
  app.delete("/api/folders/:id", async (request, reply) => {
    const rows =
      await db`DELETE FROM folders WHERE id=${param(request)} AND user_id=${user(request)} RETURNING id`;
    if (!rows.length)
      throw new ApiFailure(404, "NOT_FOUND", "Folder not found");
    reply.code(204).send();
  });
  app.get("/api/tags", async (request) => ({
    items: await articles.tags(user(request)),
  }));
  app.post("/api/tags", async (request, reply) => {
    const input = z
        .object({ name, color: color.optional() })
        .strict()
        .parse(request.body),
      tagId = id();
    await db`INSERT INTO tags(id,user_id,name,color) VALUES(${tagId},${user(request)},${input.name},${input.color || "#861dd4"})`;
    reply.code(201);
    return (await articles.tags(user(request))).find((t) => t.id === tagId);
  });
  app.patch("/api/tags/:id", async (request) => {
    const input = z
        .object({ name: name.optional(), color: color.optional() })
        .strict()
        .parse(request.body),
      tagId = param(request);
    const rows =
      await db`UPDATE tags SET name=COALESCE(${input.name ?? null},name),color=COALESCE(${input.color ?? null},color) WHERE id=${tagId} AND user_id=${user(request)} RETURNING id`;
    if (!rows.length) throw new ApiFailure(404, "NOT_FOUND", "Tag not found");
    return (await articles.tags(user(request))).find((t) => t.id === tagId);
  });
  app.delete("/api/tags/:id", async (request, reply) => {
    const rows =
      await db`DELETE FROM tags WHERE id=${param(request)} AND user_id=${user(request)} RETURNING id`;
    if (!rows.length) throw new ApiFailure(404, "NOT_FOUND", "Tag not found");
    reply.code(204).send();
  });
  app.get("/api/articles", async (request) =>
    articles.page(user(request), articleQuery.parse(request.query)),
  );
  app.get("/api/articles/:id", async (request, reply) => {
    const result = await articles.detail(user(request), param(request));
    reply.header("ETag", `"${result.stateVersion}"`);
    return result;
  });
  app.patch("/api/articles/:id/state", async (request, reply) => {
    const header = request.headers["if-match"];
    if (
      header !== undefined &&
      (typeof header !== "string" ||
        !/^"\d+"$/.test(header) ||
        !Number.isSafeInteger(Number(header.slice(1, -1))))
    )
      throw new ApiFailure(
        400,
        "INVALID_PRECONDITION",
        "If-Match must contain one quoted integer state version",
      );
    const result = await articles.patch(
      user(request),
      param(request),
      statePatch.parse(request.body),
      header === undefined ? undefined : Number(header.slice(1, -1)),
    );
    reply.header("ETag", `"${result.stateVersion}"`);
    return result;
  });
  app.post("/api/articles/bulk-state", async (request) => {
    const input = z
      .object({
        ids: z.array(uuid).max(1000).optional(),
        query: articleQuery.optional(),
        read: z.boolean(),
      })
      .strict()
      .refine((v) => !(v.ids && v.query), "Choose ids or query, not both")
      .parse(request.body);
    return articles.bulk(user(request), input.read, input.ids, input.query);
  });
  app.post(
    "/api/articles/:id/fulltext",
    { config: outboundLimit },
    async (request) => {
      const article = await articles.owned(user(request), param(request));
      if (
        request.account!.is_demo &&
        article.url === `${config.appUrl}/?article=${article.id}`
      ) {
        await db`UPDATE articles SET fulltext_html=content_html,fulltext_hash=content_hash,fulltext_fetched_at=now(),fulltext_error=null WHERE id=${article.id}`;
      } else {
        await demoOutbound(request);
        await content.extract(article);
      }
      return articles.detail(user(request), article.id);
    },
  );
  app.post(
    "/api/articles/:id/retry-images",
    { config: outboundLimit },
    async (request) => {
      await demoOutbound(request);
      const article = await articles.owned(user(request), param(request));
      await content.retry(article);
      return articles.detail(user(request), article.id);
    },
  );
  app.post(
    "/api/articles/save-url",
    { config: outboundLimit },
    async (request, reply) => {
      await demoOutbound(request);
      const input = z.object({ url }).strict().parse(request.body),
        target = fetcher.validate(input.url).href,
        userId = user(request);
      const [existing] =
        await db`SELECT id FROM articles WHERE user_id=${userId} AND feed_id IS NULL AND url=${target}`;
      if (existing) {
        reply.code(201);
        return articles.detail(userId, existing.id);
      }
      if (request.account!.is_demo) {
        const [{ count }] =
          await db`SELECT count(*)::integer AS count FROM articles WHERE user_id=${userId}`;
        if (count >= 100)
          throw new ApiFailure(
            429,
            "DEMO_QUOTA",
            "Demo archive limit is 100 articles; register for your own library",
          );
      }
      const articleId = id();
      await db`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash,saved) VALUES(${articleId},${userId},${articleId},'Saved links',${new URL(target).hostname},${target},now(),'','',${hash("")},true)`;
      const article = await articles.owned(userId, articleId);
      await content.extract(article);
      reply.code(201);
      return articles.detail(userId, articleId);
    },
  );
  app.get("/api/feed-icons/:id", async (request, reply) => {
    const [feed] =
      await db`SELECT icon_file_key FROM feeds WHERE id=${param(request)} AND user_id=${user(request)}`;
    if (!feed?.icon_file_key)
      throw new ApiFailure(404, "NOT_FOUND", "Feed icon not found");
    reply
      .type("image/png")
      .header("Content-Security-Policy", "default-src 'none'");
    return store.get(feed.icon_file_key);
  });
  app.get("/api/assets/:id", async (request, reply) => {
    const [image] =
      await db`SELECT i.* FROM images i JOIN articles a ON a.id=i.article_id WHERE i.id=${param(request)} AND a.user_id=${user(request)}`;
    if (!image) throw new ApiFailure(404, "NOT_FOUND", "Image not found");
    if (image.status !== "cached" || !image.file_key)
      throw new ApiFailure(
        404,
        "IMAGE_UNAVAILABLE",
        "The image was not captured; retry from the article",
      );
    reply
      .type(image.content_type)
      .header("Content-Security-Policy", "default-src 'none'");
    return store.get(image.file_key);
  });
  app.post("/api/import/opml", { config: outboundLimit }, async (request) => {
    await demoOutbound(request);
    const input = z
      .object({ content: z.string().max(1024 * 1024) })
      .strict()
      .parse(request.body);
    return feeds.importOpml(user(request), input.content);
  });
  app.get("/api/export/opml", async (request, reply) => {
    reply
      .type("text/x-opml; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="feedink.opml"');
    return feeds.exportOpml(user(request));
  });
  app.get(
    "/api/export/archive",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply
        .type("application/zip")
        .header(
          "Content-Disposition",
          'attachment; filename="feedink-archive.zip"',
        );
      return archives.export(user(request));
    },
  );
  app.post(
    "/api/import/archive",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const file = await request.file();
      if (!file || file.fieldname !== "file")
        throw new ApiFailure(
          400,
          "FILE_REQUIRED",
          "Upload one ZIP in the file field",
        );
      const bytes = await file.toBuffer();
      if (file.file.truncated)
        throw new ApiFailure(413, "ARCHIVE_LIMIT", "Archive exceeds 128 MiB");
      return archives.import(user(request), bytes);
    },
  );
  app.get("/api/ebooks", async (request) => ({
    items: (
      await db`SELECT * FROM ebooks WHERE user_id=${user(request)} ORDER BY created_at DESC LIMIT 1000`
    ).map(ebookDto),
  }));
  app.post(
    "/api/ebooks",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = z
        .object({
          articleIds: z.array(uuid).min(1).max(100),
          title: name.optional(),
          send: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
      const result = await ebooks.create(
        request.account!,
        input.articleIds,
        input.title,
        input.send,
      );
      reply.code(201);
      return result;
    },
  );
  app.get("/api/ebooks/:id/download", async (request, reply) => {
    const [ebook] =
      await db`SELECT * FROM ebooks WHERE id=${param(request)} AND user_id=${user(request)}`;
    if (!ebook) throw new ApiFailure(404, "NOT_FOUND", "Ebook not found");
    if (!ebook.file_key)
      throw new ApiFailure(
        409,
        "EBOOK_UNAVAILABLE",
        "Ebook generation failed; create a new ebook",
      );
    reply
      .type("application/epub+zip")
      .header("Content-Disposition", 'attachment; filename="feedink.epub"');
    return store.get(ebook.file_key);
  });
  const hasWeb = await stat(config.webDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (hasWeb)
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: "/",
      wildcard: false,
    });
  app.setNotFoundHandler(async (request, reply) => {
    if (
      !request.url.startsWith("/api/") &&
      request.method === "GET" &&
      hasWeb
    ) {
      reply
        .header("Cache-Control", "no-cache")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' https: http: blob:; connect-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        );
      return reply.sendFile("index.html");
    }
    reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
  let stopped = false,
    working: Promise<void> | undefined;
  const tick = async () => {
    const lock = await db.reserve();
    try {
      const [result] =
        await lock`SELECT pg_try_advisory_lock(71244002) AS locked`;
      if (!result.locked) return;
      try {
        await lock`DELETE FROM sessions WHERE expires_at<now()`;
        await lock`DELETE FROM demo_outbound_usage WHERE bucket<${Math.floor(Date.now() / 300000) - 1}`;
        const due =
          await lock`SELECT f.* FROM feeds f JOIN subscriptions s ON s.feed_id=f.id JOIN users u ON u.id=f.user_id WHERE f.next_fetch_at<=now() AND NOT u.disabled AND NOT u.is_demo ORDER BY f.next_fetch_at LIMIT 10`;
        for (const feed of due) {
          if (stopped) break;
          await feeds.refresh(feed, lock);
        }
        if (!stopped) {
          const pending =
            await lock`SELECT i.*,a.url AS source_url FROM images i JOIN articles a ON a.id=i.article_id JOIN users u ON u.id=a.user_id WHERE i.status='pending' AND NOT u.disabled AND NOT u.is_demo LIMIT 20`;
          const deadline = Date.now() + 30000;
          for (const image of pending) {
            if (stopped || Date.now() >= deadline) break;
            await content.cacheImage(image, image.source_url, deadline, lock);
          }
          await ebooks.schedules(new Date(), lock);
        }
      } finally {
        await lock`SELECT pg_advisory_unlock(71244002)`;
      }
    } finally {
      lock.release();
    }
  };
  const timer = config.worker
    ? setInterval(() => {
        if (!working && !stopped) {
          working = tick()
            .catch((e) => app.log.error({ code: e.code }, "Worker tick failed"))
            .finally(() => {
              working = undefined;
            });
        }
      }, 30000)
    : undefined;
  timer?.unref();
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await working;
    if (!providedDb) await db.end({ timeout: 5 });
  });
  return { app, db, store, feeds, articles, content, archives, ebooks, tick };
}
