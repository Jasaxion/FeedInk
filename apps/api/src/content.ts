import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sharp from "sharp";
import type { DB, SQL, Row, Store } from "./core.js";
import { id, hash, ApiFailure, safeError, withConnection } from "./core.js";
import { SafeFetcher, requireOk } from "./network.js";

export function httpUrl(
  value: string | undefined,
  base: string,
): string | null {
  try {
    const u = new URL(value || "", base);
    return value &&
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.href.length <= 4096
      ? u.href
      : null;
  } catch {
    return null;
  }
}
// Keep finalized HTML within the same string-length ceiling as archive bodies.
export const ARTICLE_HTML_MAX_LENGTH = 2 * 1024 * 1024;
export function cleanHtml(html: string): string {
  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      "p",
      "div",
      "span",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "br",
      "hr",
      "b",
      "strong",
      "i",
      "em",
      "s",
      "del",
      "u",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "caption",
      "figure",
      "figcaption",
      "a",
      "img",
      "sub",
      "sup",
      "details",
      "summary",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      "*": ["lang", "dir"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: "a",
        attribs: { ...attrs, rel: "noopener noreferrer", target: "_blank" },
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === "img" &&
      !/^\/api\/assets\/[a-f0-9-]{36}$/.test(frame.attribs.src || ""),
    parser: { lowerCaseTags: true },
  });
  if (sanitized.length > ARTICLE_HTML_MAX_LENGTH)
    throw new ApiFailure(
      413,
      "CONTENT_SIZE",
      "Sanitized article HTML exceeds the archive body limit (2097152 characters)",
    );
  return sanitized;
}
export const htmlText = (html: string) =>
  cheerio.load(html).text().replace(/\s+/g, " ").trim();
export const countWords = (text: string) =>
  [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].filter(
    (s) => s.isWordLike,
  ).length;
export async function raster(
  data: Buffer,
): Promise<{ bytes: Buffer; type: string }> {
  try {
    const image = sharp(data, {
      limitInputPixels: 25_000_000,
      animated: false,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp", "gif", "avif"].includes(metadata.format || ""))
      throw new Error("unsupported");
    // Decode/re-encode removes metadata and polyglot trailing payloads; no active SVG is served.
    const bytes = await image.rotate().png().toBuffer();
    if (bytes.length > 16 * 1024 * 1024)
      throw new Error("decoded output limit");
    return { bytes, type: "image/png" };
  } catch {
    throw new ApiFailure(
      422,
      "INVALID_IMAGE",
      "Image is unsupported, invalid or exceeds the pixel limit",
    );
  }
}
export class Content {
  constructor(
    readonly db: DB,
    readonly store: Store,
    readonly fetcher: SafeFetcher,
  ) {}
  async cacheImage(
    image: Row,
    sourceUrl: string,
    deadline = Date.now() + 15000,
    connection?: SQL,
  ) {
    return withConnection(
      this.db,
      async (sql) => {
        if (image.status === "cached") return;
        try {
          if (deadline <= Date.now())
            throw new ApiFailure(
              504,
              "CAPTURE_BUDGET",
              "Image capture time limit reached; retry this article",
            );
          let result = await this.fetcher.fetch(image.original_url, {
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: Math.min(15000, deadline - Date.now()),
          });
          if ([403, 406].includes(result.status)) {
            const source = new URL(sourceUrl);
            source.username = "";
            source.password = "";
            source.hash = "";
            source.search = "";
            result = await this.fetcher.fetch(image.original_url, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())),
              headers: { Referer: source.href },
            });
          }
          requireOk(result);
          const { bytes, type } = await raster(result.body);
          await this.store.writeTransaction(sql, async (put) => {
            const [current] =
              await sql`SELECT status FROM images WHERE id=${image.id} FOR UPDATE`;
            if (!current || current.status === "cached") return;
            const key = await put(bytes);
            await sql`UPDATE images SET status='cached',content_type=${type},file_key=${key},content_hash=${hash(bytes)},captured_at=now(),last_error=null WHERE id=${image.id}`;
          });
        } catch (e) {
          await sql`UPDATE images SET status='failed',last_error=${safeError(e)} WHERE id=${image.id} AND status!='cached'`;
        }
      },
      connection,
    );
  }
  async capture(
    articleId: string,
    html: string,
    baseUrl: string,
    sql: SQL = this.db,
  ) {
    if (html.length > ARTICLE_HTML_MAX_LENGTH)
      throw new ApiFailure(
        413,
        "CONTENT_SIZE",
        "Article content exceeds the limit",
      );
    const $ = cheerio.load(html, {}, false);
    $("script,style,iframe,object,embed,form,base,link,meta").remove();
    $("a").each((_, a) => {
      const href = httpUrl($(a).attr("href"), baseUrl);
      if (href) $(a).attr("href", href);
      else $(a).removeAttr("href");
    });
    const elements = $("img").toArray();
    const knownImages = new Set(
      (
        await sql`SELECT original_url FROM images WHERE article_id=${articleId}`
      ).map((i) => i.original_url as string),
    );
    for (const [index, element] of elements.entries()) {
      if (index >= 50) {
        $(element).replaceWith("<span>[Image limit reached]</span>");
        continue;
      }
      const image = $(element);
      // WeChat frequently has a placeholder src but the actual image in data-src.
      const candidates = [
        image.attr("data-src"),
        image.attr("data-original"),
        image.attr("data-lazy-src"),
        ...(image.attr("srcset") || image.attr("data-srcset") || "")
          .split(",")
          .map((s) => s.trim().split(/\s+/)[0])
          .reverse(),
        image.attr("src"),
      ];
      const remote = candidates.map((s) => httpUrl(s, baseUrl)).find(Boolean);
      if (!remote) {
        image.remove();
        continue;
      }
      if (!knownImages.has(remote) && knownImages.size >= 100) {
        image.replaceWith("<span>[Article image archive limit reached]</span>");
        continue;
      }
      knownImages.add(remote);
      const [record] =
        await sql`INSERT INTO images (id,article_id,original_url) VALUES (${id()},${articleId},${remote}) ON CONFLICT (article_id,original_url) DO UPDATE SET original_url=EXCLUDED.original_url RETURNING *`;
      image.attr("src", `/api/assets/${record.id}`);
      for (const attribute of [
        "srcset",
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-srcset",
      ])
        image.removeAttr(attribute);
    }
    const sanitized = cleanHtml($.html()),
      text = htmlText(sanitized);
    return {
      html: sanitized,
      text,
      hash: hash(sanitized),
      words: countWords(text),
    };
  }
  async extract(article: Row) {
    return withConnection(this.db, async (sql) => {
      try {
        const page = requireOk(await this.fetcher.fetch(article.url));
        const dom = new JSDOM(page.body.toString("utf8"), { url: page.url });
        let extracted;
        try {
          extracted = new Readability(dom.window.document, {
            charThreshold: 80,
          }).parse();
        } finally {
          dom.window.close();
        }
        if (!extracted?.content)
          throw new ApiFailure(
            422,
            "FULLTEXT_EMPTY",
            "No readable article was found on the page",
          );
        await sql`BEGIN`;
        try {
          // Match archive restore's article-before-images order and reject stale sources.
          const [current] =
            await sql`SELECT * FROM articles WHERE id=${article.id} AND user_id=${article.user_id} AND url=${article.url} FOR UPDATE`;
          if (!current) {
            await sql`ROLLBACK`;
            return false;
          }
          const captured = await this.capture(
            current.id,
            extracted.content,
            page.url,
            sql,
          );
          await sql`UPDATE articles SET fulltext_html=${captured.html},fulltext_hash=${captured.hash},fulltext_fetched_at=now(),fulltext_error=null,content_text=${captured.text},word_count=${captured.words},title=${current.feed_id ? current.title : (extracted.title || current.title).slice(0, 1000)},summary=${current.feed_id ? current.summary : captured.text.slice(0, 400)} WHERE id=${current.id} AND user_id=${current.user_id}`;
          await sql`COMMIT`;
        } catch (e) {
          await sql`ROLLBACK`;
          throw e;
        }
        await this.retry(article, sql);
        return true;
      } catch (e) {
        await sql`UPDATE articles SET fulltext_error=${safeError(e)} WHERE id=${article.id} AND user_id=${article.user_id} AND url=${article.url}`;
        return false;
      }
    });
  }
  async retry(article: Row, connection?: SQL) {
    return withConnection(
      this.db,
      async (sql) => {
        const deadline = Date.now() + 30000;
        for (const image of await sql`SELECT * FROM images WHERE article_id=${article.id} AND status!='cached' LIMIT 50`) {
          if (Date.now() >= deadline) break;
          await this.cacheImage(image, article.url, deadline, sql);
        }
      },
      connection,
    );
  }
}
