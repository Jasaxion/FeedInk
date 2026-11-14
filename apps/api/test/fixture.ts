import { createServer } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
export async function upstreamFixture() {
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#7755bb" },
  })
    .png()
    .toBuffer();
  let base = "",
    version = 1,
    online = true,
    conditionals = 0,
    referers = 0;
  const server = createServer((req, res) => {
    if (!online) {
      res.writeHead(503).end("source offline");
      return;
    }
    if (req.url === "/page") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><html><head><title>Fixture</title><link rel="alternate" type="application/rss+xml" href="/feed"/></head></html>`,
      );
      return;
    }
    if (req.url === "/feed") {
      if (req.headers["if-none-match"] === `"v${version}"`) {
        conditionals++;
        res.writeHead(304).end();
        return;
      }
      res.setHeader("ETag", `"v${version}"`);
      res.setHeader("Content-Type", "application/rss+xml");
      res.end(
        `<rss version="2.0"><channel><title>独立夹具</title><link>${base}/page</link><description>Controlled feed</description>${version === 1 ? `<item><guid>one</guid><title>中文归档与 durable archive</title><link>${base}/article</link><pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate><description><![CDATA[<h2>正文内容</h2><p>中文搜索和永久存档是重要能力。Durable snapshots survive a disappearing upstream.</p><img src="/placeholder" data-src="${base}/protected.png" onerror="alert(1)"/><img srcset="${base}/small.png 1x, ${base}/large.png 2x"/><img src="${base}/bad.svg"/><script>alert(1)</script>]]></description></item>` : ""}<item><guid>two</guid><title>Second entry</title><link>${base}/second</link><pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Another article for pagination</p>]]></description></item></channel></rss>`,
      );
      return;
    }
    if (req.url === "/atom") {
      res.setHeader("Content-Type", "application/atom+xml");
      res.end(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom fixture</title><id>${base}/atom</id><entry><id>urn:fixture:atom</id><title>Atom original</title><link href="${base}/article"/><content type="html">&lt;p&gt;Atom full body&lt;/p&gt;</content></entry></feed>`,
      );
      return;
    }
    if (req.url === "/json") {
      res.setHeader("Content-Type", "application/feed+json");
      res.end(
        JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "JSON fixture",
          items: [
            {
              id: "json-1",
              title: "JSON original",
              url: base + "/article",
              content_html: "<p>JSON full body</p>",
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/article" || req.url === "/saved") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<html><head><title>完整文章标题</title></head><body><main><article><h1>完整文章标题</h1>${Array.from({ length: 6 }, (_, i) => `<p>这是第 ${i + 1} 段原创测试正文，包含完整阅读体验需要保存的内容。The original full text remains available after the source has stopped serving it. An archive should not be a transient proxy, and every image must be durable.</p>`).join("")}<img data-src="${base}/protected.png"/></article></main></body></html>`,
      );
      return;
    }
    if (req.url === "/protected.png") {
      if (
        req.headers.referer !== base + "/article" &&
        req.headers.referer !== base + "/saved"
      ) {
        res.writeHead(403).end();
        return;
      }
      referers++;
      res.setHeader("Content-Type", "image/png");
      res.end(image);
      return;
    }
    if (req.url === "/large.png" || req.url === "/small.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(image);
      return;
    }
    if (req.url === "/bad.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      return;
    }
    if (req.url === "/redirect") {
      res
        .writeHead(302, {
          Location: "http://169.254.169.254/latest/meta-data/",
        })
        .end();
      return;
    }
    if (req.url === "/xxe") {
      res.end(
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    base,
    get conditionals() {
      return conditionals;
    },
    get referers() {
      return referers;
    },
    omitOldArticle() {
      version++;
    },
    offline() {
      online = false;
    },
    online() {
      online = true;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
