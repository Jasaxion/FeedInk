import { boundedText, normalizeEnclosures, xmlCharacters } from "./metadata.js";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import type { DiscoveryFeed, Subscription } from "@feedink/shared";
import {
  type DB,
  type SQL,
  withConnection,
  type Row,
  id,
  hash,
  iso,
  ApiFailure,
  safeError,
} from "./core.js";
import {
  ARTICLE_HTML_MAX_LENGTH,
  Content,
  httpUrl,
  htmlText,
  cleanHtml,
  raster,
} from "./content.js";
import { SafeFetcher, requireOk } from "./network.js";

export interface FeedEntry {
  guid: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string;
  html: string;
  enclosures: { url: string; type: string; length?: number }[];
}
export interface ParsedFeed {
  title: string;
  siteUrl: string;
  description: string;
  iconUrl?: string;
  entries: FeedEntry[];
}
export function rejectXmlEntities(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new ApiFailure(
      400,
      "UNSAFE_XML",
      "XML declarations with DTDs or entities are not allowed",
    );
}
function date(value: unknown) {
  const result = new Date(String(value || ""));
  return Number.isFinite(result.getTime())
    ? result.toISOString()
    : new Date().toISOString();
}
export async function parseFeed(
  body: string,
  baseUrl: string,
): Promise<ParsedFeed> {
  const parser = new Parser<
    Record<string, unknown>,
    { id?: string; author?: string; encoded?: string }
  >({
    customFields: { item: [["content:encoded", "encoded"], "id", "author"] },
  });
  if (body.trim().startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiFailure(422, "INVALID_FEED", "Invalid JSON Feed");
    }
    if (
      !String(parsed.version).startsWith("https://jsonfeed.org/version/") ||
      !Array.isArray(parsed.items)
    )
      throw new ApiFailure(422, "INVALID_FEED", "This is not a JSON Feed");
    return {
      title: boundedText(parsed.title || "Untitled feed", 500),
      siteUrl: httpUrl(parsed.home_page_url, baseUrl) || baseUrl,
      description: boundedText(parsed.description || "", 4000),
      iconUrl: httpUrl(parsed.icon || parsed.favicon, baseUrl) || undefined,
      entries: parsed.items.slice(0, 100).map((item: any) => {
        const link = httpUrl(item.url || item.external_url, baseUrl) || baseUrl;
        return {
          guid: boundedText(item.id || link, 4096),
          title: boundedText(item.title || "Untitled article", 1000),
          url: link,
          author: item.authors?.[0]?.name
            ? boundedText(item.authors[0].name, 1000)
            : null,
          publishedAt: date(item.date_published),
          html:
            typeof item.content_html === "string"
              ? item.content_html
              : `<p>${escapeXml(String(item.content_text || item.summary || ""))}</p>`,
          enclosures: normalizeEnclosures(item.attachments, baseUrl),
        };
      }),
    };
  }
  rejectXmlEntities(body);
  let parsed;
  try {
    parsed = await parser.parseString(body);
  } catch {
    throw new ApiFailure(
      422,
      "INVALID_FEED",
      "This is not a valid RSS or Atom feed",
    );
  }
  return {
    title: boundedText(parsed.title || "Untitled feed", 500),
    siteUrl: httpUrl(parsed.link, baseUrl) || baseUrl,
    description: boundedText(parsed.description || "", 4000),
    iconUrl: httpUrl(parsed.image?.url, baseUrl) || undefined,
    entries: parsed.items.slice(0, 100).map((item) => {
      const link = httpUrl(item.link, baseUrl) || baseUrl;
      return {
        guid: String(
          item.guid ||
            item.id ||
            item.link ||
            hash(`${item.title}|${item.pubDate}`),
        ).slice(0, 4096),
        title: boundedText(item.title || "Untitled article", 1000),
        url: link,
        author:
          item.creator || item.author
            ? boundedText(item.creator || item.author, 1000)
            : null,
        publishedAt: date(item.isoDate || item.pubDate),
        html:
          item.encoded ||
          item.content ||
          item.summary ||
          `<p>${escapeXml(item.contentSnippet || "")}</p>`,
        enclosures: normalizeEnclosures(
          item.enclosure ? [item.enclosure] : [],
          baseUrl,
        ),
      };
    }),
  };
}
export const escapeXml = (s: string) =>
  xmlCharacters(s).replace(
    /[<>&'\"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c]!,
  );
const suggestions: (DiscoveryFeed & { topic: string })[] = [
  {
    url: "https://www.nasa.gov/feed/",
    title: "NASA",
    description: "Space and science news",
    siteUrl: "https://www.nasa.gov/",
    topic: "science",
  },
  {
    url: "https://hnrss.org/frontpage",
    title: "Hacker News",
    description: "Technology and programming",
    siteUrl: "https://news.ycombinator.com/",
    topic: "technology",
  },
  {
    url: "https://sspai.com/feed",
    title: "少数派",
    description: "数字生活与效率",
    siteUrl: "https://sspai.com/",
    topic: "technology",
  },
  {
    url: "https://www.ruanyifeng.com/blog/atom.xml",
    title: "阮一峰的网络日志",
    description: "技术与阅读",
    siteUrl: "https://www.ruanyifeng.com/blog/",
    topic: "technology",
  },
];
export class Feeds {
  constructor(
    readonly db: DB,
    readonly fetcher: SafeFetcher,
    readonly content: Content,
  ) {}
  async discover(query = "", topic = ""): Promise<DiscoveryFeed[]> {
    if (query.startsWith("rsshub://")) {
      const base = process.env.RSSHUB_URL || "https://rsshub.app";
      query = `${base.replace(/\/$/, "")}/${query.slice("rsshub://".length).replace(/^\/+/, "")}`;
    }
    if (!/^https?:\/\//i.test(query))
      return suggestions
        .filter(
          (f) =>
            (!topic || f.topic === topic) &&
            (!query ||
              `${f.title} ${f.description}`
                .toLowerCase()
                .includes(query.toLowerCase())),
        )
        .map(({ topic: _, ...feed }) => feed);
    const response = requireOk(await this.fetcher.fetch(query));
    const body = response.body.toString("utf8");
    // Only complete leading comments are skipped for document classification.
    // Feed/OPML entity restrictions still inspect the original document.
    let prolog = body.trimStart();
    while (prolog.startsWith("<!--")) {
      const end = prolog.indexOf("-->", 4);
      if (end === -1) break;
      prolog = prolog.slice(end + 3).trimStart();
    }
    const htmlDocument =
      /^<!doctype\s+html\s*>/i.test(prolog) ||
      (/^text\/html\b/i.test(String(response.headers["content-type"] || "")) &&
        !/<!DOCTYPE|<!ENTITY/i.test(body));
    if (htmlDocument && /<!ENTITY/i.test(body)) rejectXmlEntities(body);
    try {
      if (htmlDocument)
        throw new ApiFailure(422, "INVALID_FEED", "HTML discovery document");
      const feed = await parseFeed(
        response.body.toString("utf8"),
        response.url,
      );
      return [
        {
          url: response.url,
          title: feed.title,
          description: feed.description,
          siteUrl: feed.siteUrl,
        },
      ];
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== "INVALID_FEED") throw e;
    }
    const $ = cheerio.load(response.body.toString("utf8"));
    const documentBase =
      httpUrl($("base").first().attr("href"), response.url) || response.url;
    const result: DiscoveryFeed[] = [];
    $('link[rel="alternate"]').each((_, element) => {
      if (
        result.length >= 10 ||
        !/^(application\/(rss\+xml|atom\+xml|feed\+json|json)|text\/xml)$/i.test(
          $(element).attr("type") || "",
        )
      )
        return;
      const url = httpUrl($(element).attr("href"), documentBase);
      if (url) {
        this.fetcher.validate(url);
        result.push({
          url,
          title: boundedText(
            $(element).attr("title") || $("title").text() || url,
            500,
          ),
          description: "",
          siteUrl: response.url,
        });
      }
    });
    if (!result.length)
      throw new ApiFailure(
        422,
        "NO_FEED",
        "No RSS, Atom or JSON Feed links were discovered",
      );
    return result;
  }
  async subscribe(
    userId: string,
    input: { url: string; title?: string; folderId?: string | null },
  ) {
    const [owner] = await this.db`SELECT is_demo FROM users WHERE id=${userId}`;
    if (owner?.is_demo) {
      const [{ count }] = await this
        .db`SELECT count(*)::integer AS count FROM subscriptions WHERE user_id=${userId}`;
      if (count >= 9)
        throw new ApiFailure(
          429,
          "DEMO_QUOTA",
          "Demo allows nine subscriptions including four examples; register to add more",
        );
    }
    if (
      input.folderId &&
      !(
        await this
          .db`SELECT id FROM folders WHERE id=${input.folderId} AND user_id=${userId}`
      ).length
    )
      throw new ApiFailure(404, "NOT_FOUND", "Folder not found");
    const [found] = await this.discover(input.url);
    if (!found) throw new ApiFailure(422, "NO_FEED", "No feed found");
    const [feed] = await this
      .db`INSERT INTO feeds (id,user_id,url,title,site_url,description) VALUES (${id()},${userId},${found.url},${found.title},${found.siteUrl},${found.description}) ON CONFLICT(user_id,url) DO UPDATE SET url=EXCLUDED.url RETURNING *`;
    const [subscription] = await this
      .db`INSERT INTO subscriptions (id,user_id,feed_id,title,folder_id) VALUES (${id()},${userId},${feed.id},${input.title || found.title},${input.folderId || null}) ON CONFLICT(feed_id) DO UPDATE SET feed_id=EXCLUDED.feed_id RETURNING id`;
    await this.refresh(feed);
    return (await this.subscriptions(userId)).find(
      (s) => s.id === subscription.id,
    )!;
  }
  async refresh(feed: Row, connection?: SQL) {
    // All protected work uses this same reserved executor; never re-enter its pool.
    return withConnection(
      this.db,
      async (lock) => {
        const [result] =
          await lock`SELECT pg_try_advisory_lock(hashtextextended(${feed.id},1)) AS locked`;
        if (!result.locked) return;
        try {
          const response = await this.fetcher.fetch(feed.url, {
            headers: {
              ...(feed.etag ? { "If-None-Match": feed.etag } : {}),
              ...(feed.last_modified
                ? { "If-Modified-Since": feed.last_modified }
                : {}),
            },
          });
          if (response.status !== 304) {
            requireOk(response);
            const parsed = await parseFeed(
              response.body.toString("utf8"),
              response.url,
            );
            for (const entry of parsed.entries) {
              const articleId = id();
              // Preserve existing snapshots on duplicate GUID, even when upstream returns a blank/corrupt replacement.
              const existing =
                await lock`SELECT id FROM articles WHERE feed_id=${feed.id} AND guid=${entry.guid}`;
              if (existing.length) continue;
              const [{ limited }] =
                await lock`SELECT u.is_demo AND (SELECT count(*) FROM articles WHERE user_id=u.id)>=100 AS limited FROM users u WHERE u.id=${feed.user_id}`;
              if (limited)
                throw new ApiFailure(
                  429,
                  "DEMO_QUOTA",
                  "Demo archive limit is 100 articles; register for your own library",
                );
              if (entry.html.length > ARTICLE_HTML_MAX_LENGTH)
                throw new ApiFailure(
                  413,
                  "CONTENT_SIZE",
                  "Article content exceeds the limit",
                );
              await lock`BEGIN`;
              try {
                const initial = cleanHtml(entry.html),
                  text = htmlText(initial);
                await lock`INSERT INTO articles (id,user_id,feed_id,guid,feed_title,title,url,author,published_at,summary,content_html,content_text,content_hash,enclosures) VALUES (${articleId},${feed.user_id},${feed.id},${entry.guid},${parsed.title},${entry.title},${entry.url},${entry.author},${entry.publishedAt},${text.slice(0, 400)},${initial},${text},${hash(initial)},${lock.json(entry.enclosures)})`;
                const captured = await this.content.capture(
                  articleId,
                  entry.html,
                  entry.url,
                  lock,
                );
                await lock`UPDATE articles SET content_html=${captured.html},content_text=${captured.text},content_hash=${captured.hash},word_count=${captured.words} WHERE id=${articleId}`;
                await lock`COMMIT`;
              } catch (e) {
                await lock`ROLLBACK`;
                throw e;
              }
            }
            await this.captureIcon(feed, parsed, lock);
            await lock`UPDATE feeds SET title=${parsed.title},site_url=${parsed.siteUrl},description=${parsed.description},etag=${response.headers.etag || null},last_modified=${response.headers["last-modified"] || null} WHERE id=${feed.id}`;
          }
          const pending =
            await lock`SELECT i.*,a.url AS source_url FROM images i JOIN articles a ON a.id=i.article_id WHERE a.feed_id=${feed.id} AND i.status='pending' LIMIT 50`;
          const imageDeadline = Date.now() + 45000;
          for (const image of pending) {
            if (Date.now() >= imageDeadline) break;
            await this.content.cacheImage(
              image,
              image.source_url,
              imageDeadline,
              lock,
            );
          }
          await lock`UPDATE feeds SET last_fetched_at=now(),status='ok',last_error=null,failures=0,next_fetch_at=now()+interval '30 minutes' WHERE id=${feed.id}`;
        } catch (e) {
          await lock`UPDATE feeds SET status='error',last_error=${safeError(e)},failures=failures+1,next_fetch_at=now()+make_interval(secs=>least(86400,300*power(2,least(failures,8)))::integer) WHERE id=${feed.id}`;
        } finally {
          await lock`SELECT pg_advisory_unlock(hashtextextended(${feed.id},1))`;
        }
      },
      connection,
    );
  }
  async captureIcon(feed: Row, parsed: ParsedFeed, sql: SQL) {
    if (
      feed.icon_file_key &&
      (!parsed.iconUrl || feed.icon_original_url === parsed.iconUrl)
    )
      return;
    try {
      let candidate = parsed.iconUrl;
      if (!candidate) {
        const page = requireOk(
          await this.fetcher.fetch(parsed.siteUrl, {
            maxBytes: 512 * 1024,
            timeoutMs: 3000,
          }),
        );
        const $ = cheerio.load(page.body.toString("utf8"));
        candidate =
          httpUrl($('link[rel~="icon"]').first().attr("href"), page.url) ||
          new URL("/favicon.ico", parsed.siteUrl).href;
      }
      const image = requireOk(
        await this.fetcher.fetch(candidate, {
          maxBytes: 2 * 1024 * 1024,
          timeoutMs: 3000,
        }),
      );
      const { bytes } = await raster(image.body);
      await this.content.store.writeTransaction(sql, async (put) => {
        const key = await put(bytes);
        await sql`UPDATE feeds SET icon_file_key=${key},icon_original_url=${candidate!} WHERE id=${feed.id}`;
      });
    } catch {
      /* Missing/unsupported icons use the client's first-party fallback; keep an existing good icon. */
    }
  }
  async subscriptions(userId: string): Promise<Subscription[]> {
    const rows = await this
      .db`SELECT s.*,f.url,f.site_url,f.description,f.icon_file_key,f.status,f.last_fetched_at,f.last_error,(SELECT count(*)::integer FROM articles a WHERE a.feed_id=f.id) AS total_count,(SELECT count(*)::integer FROM articles a WHERE a.feed_id=f.id AND NOT a.read) AS unread_count FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=${userId} ORDER BY (s.settings->>'pinned')::boolean DESC NULLS LAST,s.position,s.title`;
    return rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      title: r.title,
      url: r.url,
      siteUrl: r.site_url,
      description: r.description,
      iconUrl: r.icon_file_key ? `/api/feed-icons/${r.feed_id}` : null,
      folderId: r.folder_id,
      unreadCount: r.unread_count,
      totalCount: r.total_count,
      settings: r.settings,
      status: r.status,
      lastFetchedAt: r.last_fetched_at ? iso(r.last_fetched_at) : null,
      lastError: r.last_error,
      position: r.position,
    }));
  }
  async importOpml(userId: string, xml: string) {
    rejectXmlEntities(xml);
    const $ = cheerio.load(xml, { xml: true });
    if (!$("opml").length)
      throw new ApiFailure(422, "INVALID_OPML", "An OPML document is required");
    const outlines = $("outline[xmlUrl],outline[xmlurl]").toArray();
    if (outlines.length > 100)
      throw new ApiFailure(
        413,
        "OPML_LIMIT",
        "Import at most 100 feeds at a time",
      );
    let imported = 0,
      skipped = 0;
    const errors: string[] = [],
      folders = new Map<string, string>(),
      deadline = Date.now() + 90000;
    for (const [index, element] of outlines.entries()) {
      if (Date.now() >= deadline) {
        skipped += outlines.length - index;
        errors.push("Import time limit reached; retry the remaining feeds");
        break;
      }
      const node = $(element),
        url = node.attr("xmlUrl") || node.attr("xmlurl") || "";
      const groups = node
        .parents("outline")
        .toArray()
        .reverse()
        .map((p) => $(p).attr("text") || $(p).attr("title") || "")
        .filter(Boolean);
      const folderName = groups.join(" / ").slice(0, 160);
      let folderId: string | undefined;
      try {
        if (folderName) {
          folderId = folders.get(folderName);
          if (!folderId) {
            const [existing] = await this
              .db`SELECT id FROM folders WHERE user_id=${userId} AND name=${folderName}`;
            folderId = existing?.id || id();
            if (!existing)
              await this
                .db`INSERT INTO folders(id,user_id,name) VALUES (${folderId!},${userId},${folderName})`;
            folders.set(folderName, folderId!);
          }
        }
        if (
          (
            await this
              .db`SELECT s.id FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=${userId} AND f.url=${url}`
          ).length
        ) {
          skipped++;
          continue;
        }
        await this.subscribe(userId, {
          url,
          title:
            (node.attr("text") || node.attr("title") || "").slice(0, 160) ||
            undefined,
          folderId,
        });
        imported++;
      } catch (e) {
        errors.push(safeError(e));
      }
    }
    return { imported, skipped, errors };
  }
  async exportOpml(userId: string) {
    const subscriptions = await this.subscriptions(userId),
      folders = await this
        .db`SELECT * FROM folders WHERE user_id=${userId} ORDER BY position,name`;
    const outline = (s: Subscription) =>
      `<outline type="rss" text="${escapeXml(s.title)}" title="${escapeXml(s.title)}" xmlUrl="${escapeXml(s.url)}" htmlUrl="${escapeXml(s.siteUrl)}"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>FeedInk subscriptions</title></head><body>${subscriptions
      .filter((s) => !s.folderId)
      .map(outline)
      .join("")}${folders
      .map(
        (f) =>
          `<outline text="${escapeXml(f.name)}">${subscriptions
            .filter((s) => s.folderId === f.id)
            .map(outline)
            .join("")}</outline>`,
      )
      .join("")}</body></opml>`;
  }
}
