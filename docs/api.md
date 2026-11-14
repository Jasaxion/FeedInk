# FeedInk API contract v1

This is the implementation contract, not a claim that endpoints already exist. Public JSON uses camelCase and the interfaces in `packages/shared/src/index.ts`. All routes are under `/api`; UUID identifiers are opaque strings, timestamps ISO-8601 UTC. JSON request/response unless noted. Errors use `{error:{code,message,details?}}` and meaningful HTTP status. Never expose password hashes, session tokens or upstream credentials.

## Session and permissions

HttpOnly opaque session cookie `feedink_session`; Secure in HTTPS production, SameSite=Lax, Path=/. Session token hashes persisted in PostgreSQL. Passwords use scrypt with random salt and constant-time comparison. Authenticated mutations require `X-CSRF-Token` from the session response, and reject foreign Origin headers. Login/register accept JSON only and reject foreign Origin. No wildcard credentialed CORS. Every resource and asset access enforces user ownership. Frontend sends credentials same-origin. Request bodies, URL counts, timeouts and authentication attempts have bounded limits.

| Method | Path | Input | Success |
|---|---|---|---|
| GET | /health | none | `{status:'ok',version,database:'ok'}` after DB probe |
| GET | /session | none | `Session`, or 401 |
| POST | /auth/register | `{email,password,name}` | 201 `Session`; minimum 10-char password |
| POST | /auth/login | `{email,password}` | `Session` |
| POST | /auth/logout | none | 204; invalidate server session |
| POST | /auth/demo | none | 201 `Session` for a new isolated disposable demo user with first-party sample content |
| PATCH | /account | `{name?,currentPassword?,password?}` | `User`; password changes revoke other sessions |
| GET | /settings | none | `ReaderSettings` |
| PATCH | /settings | partial validated settings | complete `ReaderSettings` |
| GET | /admin/users | admin only | `{items:[User & {disabled:boolean}]}` |
| PATCH | /admin/users/:id | admin only `{disabled?:boolean}` | user record; revoke disabled user's sessions, disallow disabling last/self admin |

Registration can be disabled by the operator. Public registration never grants admin privileges based on an email string. An operator-only `bootstrap-admin` CLI reads `ADMIN_EMAIL`, `ADMIN_NAME` and `ADMIN_PASSWORD_FILE`, uses a transaction/lock and refuses existing emails or existing active admins; never pass the password on argv or print it. `TRUST_PROXY` may contain explicitly trusted IPs/CIDRs, defaults false and rejects universal ranges; never blindly trust forwarded headers. No hardcoded production credentials. Demo accounts are isolated and may not send mail/administer users. Demo data must be original, redistributable examples. PWA logout must clear private offline state; another account must never see prior-user articles.

## Subscriptions, organization, discovery

| Method | Path | Input | Success |
|---|---|---|---|
| GET | /subscriptions | none | `{items:Subscription[]}` |
| POST | /subscriptions | `{url,title?,folderId?}` | 201 `Subscription`; discover page feed links when needed, persist and fetch initial feed |
| PATCH | /subscriptions/:id | `{title?,folderId?,position?,settings?:FeedPreferences}` | `Subscription` |
| DELETE | /subscriptions/:id | none | 204; unsubscribe WITHOUT deleting archived articles/images |
| POST | /subscriptions/:id/refresh | none | `Subscription`; bounded fetch, return useful errors |
| GET | /discover | `?q=URL-or-keywords&topic=optional` | `DiscoveryResult`; curated discover suggestions plus SSRF-safe URL discovery |
| GET | /folders | none | `{items:Folder[]}` |
| POST | /folders | `{name}` | 201 `Folder` |
| PATCH | /folders/:id | `{name?,position?,settings?:FeedPreferences}` | `Folder` |
| DELETE | /folders/:id | none | 204; move subscriptions out, do not delete articles |
| GET | /tags | none | `{items:Tag[]}` |
| POST | /tags | `{name,color?}` | 201 `Tag` |
| PATCH | /tags/:id | `{name?,color?}` | `Tag` |
| DELETE | /tags/:id | none | 204; remove labels only |
| POST | /import/opml | `{content:string}` | `{imported:number,skipped:number,errors:string[]}`; nested folders; no external XML entities |
| GET | /export/opml | none | downloadable XML with escaped titles and grouping |

Subscription configuration belongs to a user even where public feed content is deduplicated. SSRF checks cover feeds, discovery, redirected full-text pages, images and favicon URLs; reject loopback/private/link-local/metadata addresses incl IPv6 and mapped IPv4, reject non-HTTP(S), userinfo and unsafe ports. Resolve and pin validated IPs through connection establishment, validate EVERY redirect. Explicit operator-only test/private-host allowlist must not be enabled by default or exposed to end users.

## Reading and persistent archives

| Method | Path | Input | Success |
|---|---|---|---|
| GET | /articles | `ArticleQuery` as query string; default all/newest/50, max100 | `ArticlePage`; stable cursor with tie-breaker, Chinese and English full-text/substring search |
| GET | /articles/:id | none | `ArticleDetail` (must NOT implicitly mark read) |
| PATCH | /articles/:id/state | `ArticleStatePatch` | `ArticleSummary` |
| POST | /articles/bulk-state | `{ids?:string[],query?:ArticleQuery,read:boolean}` | `{updated:number}`; query applies exact visible selection/filter, max explicit ids1000 |
| POST | /articles/:id/fulltext | none | `ArticleDetail`; safe Readability extraction, persists result and images |
| POST | /articles/:id/retry-images | none | `ArticleDetail` with updated image statuses |
| POST | /articles/save-url | `{url}` | 201 `ArticleDetail`; read-later full-text URL capture |
| GET | /assets/:id | opaque known image ID; auth required | cached image bytes; no arbitrary URL open proxy |
| GET | /feed-icons/:id | opaque owned feed ID; auth required | safely captured source-specific raster icon or clear not-found; no arbitrary URL proxy |
| GET | /export/archive | none | downloadable ZIP with versioned manifest, owned article/state/tag/feed metadata and cached image bytes |
| POST | /import/archive | multipart `file` ZIP | `{imported,skipped,errors}`; bound sizes/counts, validate paths/types, sanitize imported HTML, remap user ownership and opaque IDs |

The server always emits integer `stateVersion` on article summaries/details. State PATCH accepts standard `If-Match: "<stateVersion>"`: compare and update atomically under the article row lock; mismatch returns 412 `STATE_CONFLICT` without applying any field/tag changes. Every state mutation, including bulk updates, increments the version. Web/PWA clients use this precondition for queued and online writes. When a conflict occurs, only the still-current pending revision in the same owner/auth epoch may refetch/retry; obsolete requests must never replay. Pre-upgrade cached rows missing a version first read fresh state. Legacy explicit API clients may omit If-Match for unconditional writes; that does not bypass auth/CSRF. Cross-tab synchronization serializes snapshot/send/ack with owner Web Locks, with a recoverable fenced fallback, not unsafe unfenced lease stealing.

The `archive` scope includes all durable articles owned by the user, including unsubscribed feeds. Ingestion creates durable access records for existing subscribers; subscribing attaches existing retained articles. Old articles must not disappear just because the current RSS payload omits them. Do not prune by age automatically. Keep feed HTML and separately extracted fulltext, captured-at timestamp, content SHA-256, original URL and image capture statuses. Duplicate GUIDs do not erase good existing content. A remote image failure must not block article reading or be reported as successful caching.

HTML must be sanitized before storage AND client rendering. Rewrite src/data-src/srcset/relative image URLs through authenticated local asset IDs, preserving lazy-load source variants used by WeChat. Proxy fetch may use source-appropriate Referer/User-Agent and safe fallback requests, but no CAPTCHA/login/paywall bypass or upstream credentials. Only accept bounded decoded raster images/validated media; never serve untrusted SVG/HTML as same-origin active content. Archive file writes are atomic and directory-bounded. Content may render from the archive when the source is gone or network is offline.

## Ebooks and audio

| Method | Path | Input | Success |
|---|---|---|---|
| GET | /ebooks | none | `{items:Ebook[]}` |
| POST | /ebooks | `{articleIds:string[],title?:string,send?:boolean}` | 201 `Ebook`; valid EPUB3 with local archived images, only owned articles |
| GET | /ebooks/:id/download | none | authenticated EPUB download |

Browser SpeechSynthesis supplies TTS where supported, with voice/speed/pause/resume/stop. Audio/video enclosures are exposed explicitly with browser players; no promise to decode unsupported codecs. Ebook email uses operator-configured SMTP (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`); no mail is sent in demo mode. The user selects destination in settings. Absent SMTP must produce a clear actionable error, not success. A scheduler handles configured intervals/hour/min/max with durable deduplication and error status. Its default selection is new eligible articles from active subscriptions, narrowed to the user's folder named `ebook` if present, not saved-only. Uncertain SMTP acceptance reserves its articles across later schedule buckets; operator-only `reconcile-ebook` with `delivered` or `not-delivered` explicitly resolves that state. A crash must not silently cause later automatic resend. Test SMTP with a local fixture, never real third-party recipients.

## Frontend integration

Routes: `/` landing (unauthenticated) or reader (authenticated), `/login`, `/register`, `/settings`, `/settings/interface/article-contents`, `/settings/interface/article-listing`, `/settings/ebook`, `/discover`, `/import`, `/export`, `/share`. Use query params for reader selections (`scope`, `subscription`, `folder`, `tag`, `article`, `q`) and preserve browser history/back. Send explicit state patches when a reader opens an article. Client caches only under the current user's ID; pending offline changes are idempotent state assignments and must not replay into another account. GET session 401 invalidates online credentials; connectivity errors may retain already-authorized offline data. Archive exports and cookies are never committed.
