# FeedInk API

Node 24 / Fastify 5 / postgres.js service. Public JSON follows `packages/shared`; route contracts are in `docs/api.md`. Build shared first, then the API. Scripts: `build=tsc`, `start=node dist/server.js`; tests run with `tsx --test --test-concurrency=1 test/*.test.ts`.

## Operator configuration

| Variable                                | Meaning                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | PostgreSQL URI, required in production. Local-only default: `postgres://feedink:feedink@localhost:5432/feedink`.                                                                                                             |
| `DATA_DIR`                              | Durable content-addressed image/ebook volume; default `/data`. Back up with PostgreSQL.                                                                                                                                      |
| `APP_URL`                               | Exact public HTTP(S) origin for CSRF/Origin checks; default `http://localhost:3000`. Use external HTTPS origin behind a proxy.                                                                                               |
| `SESSION_SECRET`                        | Required unpredictable secret, at least 32 characters. Never publish it.                                                                                                                                                     |
| `HOST`, `PORT`                          | Defaults `0.0.0.0:3000`.                                                                                                                                                                                                     |
| `REGISTRATION_ENABLED`                  | `false` disables normal public registration. Demo remains available. Registration never grants administrator privileges.                                                                                                     |
| `ADMIN_EMAIL`, `ADMIN_NAME`             | Inputs to the operator bootstrap command only; ignored by public registration.                                                                                                                                               |
| `ADMIN_PASSWORD_FILE`                   | Bootstrap password secret file. Explicit `/dev/stdin` reads stdin. Both input methods are bounded to 1,024 bytes; password validation is 10–256 characters. No password argv or log.                                         |
| `TRUST_PROXY`                           | Empty/unset means false. Otherwise comma-separated exact proxy IP addresses/CIDRs, e.g. `127.0.0.1/32`. No hop counts, keywords, hostnames or universal ranges. Include only actual controlled proxies, not client networks. |
| `FETCH_ALLOW_HOSTS`                     | **Operator-only** exact hostnames/IPs allowed private addresses/nonstandard ports. Default empty. Redirect destinations still get checked. Never grant an untrusted user a fetch exception.                                  |
| `RSSHUB_URL`                            | Base for `rsshub://route/path`, default `https://rsshub.app`. Expanded URLs retain all SSRF restrictions.                                                                                                                    |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Operator SMTP host, port (587 default), implicit TLS (`true`; default false). STARTTLS is negotiated when offered otherwise.                                                                                                 |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`   | Optional SMTP authentication and required from address. Not exposed in API JSON.                                                                                                                                             |
| `WORKER_ENABLED`                        | `false` for deterministic tests or replicas with another worker-enabled instance.                                                                                                                                            |
| `WEB_DIST`                              | Optional override of `apps/web/dist`.                                                                                                                                                                                        |

### Administrator bootstrap

Start PostgreSQL, build/install the application, then run the operator command before exposing the public application. It applies migrations itself. Database credentials authorize this operation; it is not an HTTP endpoint.

```sh
# Use the application environment and an operator-managed secret file:
ADMIN_EMAIL=owner@example.org ADMIN_PASSWORD_FILE=/run/secrets/admin-password \
  npm run bootstrap-admin -w @feedink/api

# Container stdin seam (provide the secret through stdin, not argv):
# Set ADMIN_EMAIL and ADMIN_PASSWORD_FILE=/dev/stdin in the one-shot container.
docker compose run -T --rm --no-deps app npm run bootstrap-admin -w @feedink/api
```

Bootstrap serializes with administrator updates and refuses an existing email or an existing active administrator. It **never elevates a pre-existing public account**, including one that registered the intended operator email first. Use an unused operator email or explicitly investigate the existing account. Remove the bootstrap secret after use. Upgrades do not silently delete or demote existing administrators: audit any accounts created by an older deployment.

### Proxy and rate limits

The application binds rate limits to the socket peer unless `TRUST_PROXY` explicitly authorizes a proxy. Behind a proxy, configure its exact address and have it append/replace forwarded headers correctly. An untrusted socket's `X-Forwarded-For` is ignored; a spoofed leftmost entry cannot override an untrusted rightmost client. Avoid broad CIDRs that also contain clients.

The general **API** budget is 300 requests/minute/client IP; public static shell requests do not consume it. Login/registration have ten attempts/minute/client IP and demo creation five/hour/client IP, with separate lower budgets for expensive routes. Exhaustion returns HTTP 429, `Retry-After`, and `{error:{code:'RATE_LIMIT',message}}`, never a generic HTTP 500. Demo outbound use also has a durable per-user quota. Do not disable protections to make a multi-case test suite share one exhausted client; use distinct trusted test clients or isolated server lifetimes.

## Persistence and network safety

Startup verifies/applies ordered SQL migrations under an advisory lock before listening. Migration checksums reject changed previously applied files. Migration 003 adds delivery-state/provenance/icon fields; migration 004 adds state fencing. The worker runs every 30 seconds with its own lock. A lock holder uses the **same reserved SQL executor for all protected work**, including nested refresh, capture and scheduling; it never waits for an extra connection from its own exhausted pool.

Normal feeds poll every 30 minutes using ETag/Last-Modified conditionals, with failure backoff from five minutes to 24 hours. Demo feeds are manually refreshable but not continuously polled. Unsubscription retains owned snapshots and cached images in `scope=archive`.

- Sanitized rewritten article HTML and pending image references commit together **before network image downloads**. An interrupted preparation rolls back the whole article; an interrupted download leaves durable references that refresh (including a 304), worker processing or retry can resume. Completed duplicate GUID snapshots are not overwritten with bad replacement content.
- Blob writes stage under the data directory, publish atomically, and commit their DB references under a shared store advisory lock. Rejected/duplicate imports do not leave permanent new blobs. Rollback cleanup does not delete shared referenced content. Startup recovers durable staging remnants, preserving keys referenced by articles, ebooks or feed icons. Do not manually remove `.stage-*` directories during a running operation.
- `/api/assets/:id` requires a live session and article ownership. `/api/feed-icons/:id` uses a feed UUID and requires feed ownership. Both return validated cached PNG bytes with `nosniff`, `no-store`, and restrictive content policy; neither accepts arbitrary proxy URLs.
- Source icons come from RSS/JSON metadata, a page icon link or same-site favicon fallback. They use the same pinned fetcher, a 2 MiB body bound and three-second request deadlines. Missing/unsupported/unsafe icons yield the client's first-party fallback, not a third-party favicon proxy. Existing good icons survive a failed recapture.
- HTTP(S) fetching rejects userinfo, unsafe ports, private/link-local/metadata/loopback and mapped/transition addresses unless explicitly operator-allowed. All DNS answers are validated; the checked address is pinned into connection setup; every redirect is revalidated. DNS, redirects, body transport and decoding share an overall deadline. Gzip, Brotli and deflate are decoded with independent encoded/decoded size limits; expansion bombs and unsupported encodings fail visibly.
- HTML uses Cheerio, Readability and a JSDOM with no script execution/subresource loading. Sanitization precedes persistence. Relative/lazy/data-src/data-original/data-lazy-src/srcset images become local asset IDs. Raster images have a 10 MiB input/25-million-pixel bound and are re-encoded as PNG (maximum 16 MiB output). SVG/HTML is never served as an active same-origin asset. A 403/406 may retry once with the source Referer, never credentials or CAPTCHA bypass.
- Feed bodies: maximum 4 MiB decoded/encoded; article HTML: 2 MiB; 100 entries/poll and 50 images/body. Initial image downloading has a 45-second budget; retry has 30 seconds. Remaining pending references survive for later batches.
- Normal `<!doctype html>` discovery works. XML feeds/OPML still reject DTD/entity declarations. OPML allows 100 feeds and maps nested groups to stable flat `/` folder paths, consistent with the flat shared Folder type.
- ZIP import never extracts supplied paths. It validates paths, file types/symlinks/encryption, byte expansion, counts and references; sanitizes HTML, validates all raster bytes, and remaps ownership/IDs. Limits: 128 MiB compressed/expanded/normalized images, 6,000 entries, 16 MiB/entry and 1,000 articles.
- Export preflights counts and JSON-escaped metadata/body sizes **inside PostgreSQL before loading full bodies**, reads articles incrementally from one repeatable-read snapshot, validates its generated manifest, and preflights image file sizes. Oversized libraries fail with controlled 413; use database plus volume backup for larger collections.
- New exports use manifest version 2, retaining fulltext/image capture timestamps and pending/failed image states. Version 1 remains importable; unknown original dates remain unknown rather than being invented. `restored_at` is separate from original capture time. Invalid legacy enclosure lengths/MIME/author metadata is normalized compatibly before export.
- XML serialization strips forbidden XML 1.0 scalars consistently from titles, metadata and chapter content, so EPUB/OPML cannot emit illegal controls.
- Custom CSS remains safe typography declarations only: color/background-color/font-size/font-family/font-weight/line-height/letter-spacing/text-align/text-indent/word-spacing. No selectors, at-rules, URLs, variables or positioning.

## State fencing

Every emitted article summary/detail has integer `stateVersion`. `PATCH /api/articles/:id/state` accepts `If-Match: "<version>"`. Ownership, version comparison, state update and tag changes occur under one row lock/transaction. A mismatch returns 412 `STATE_CONFLICT` with **no changes**. Successful patches and every bulk mutation increment the version. GET detail and PATCH return the corresponding ETag. Legacy callers may omit the precondition; the web client should always send it and only retry a still-current pending revision.

## Demo behavior

Each login creates independent records and first-party generated PNGs. Reading, fulltext, discovery, external subscriptions, imports and exports are real, using the same security pipeline. Limits: ten external operations/five-minute user bucket; nine subscriptions including four examples; 100 articles. Excess returns `DEMO_QUOTA`. Demo mail/admin/password changes remain forbidden. There is no aggressive account cleanup that can affect normal users' archives.

## Ebooks and scheduled delivery

EPUB3 has an uncompressed first `mimetype`, container, OPF, navigation and XHTML chapters with local cached images. At most 100 owned articles and 64 MiB image content per book. Missing images are labeled. XML is well-formed even with hostile source metadata.

Scheduled selection defaults to **all active subscriptions**, not saved-only. If an owned folder named `ebook` exists (case-insensitive), only its subscriptions participate. Saved standalone links and unsubscribed feeds do not enter the scheduled selection. Successfully sent or uncertain scheduled articles are excluded. `ebookHour` is UTC; intervals use durable UTC epoch-day buckets, minimum/maximum counts and a unique user/bucket job. Per-user advisory locks serialize scheduling across replicas.

Delivery has explicit `not_sent`, `sending`, `unknown`, `sent`, and `not_delivered` states. The transition to `sending` commits before contacting SMTP. A crash/uncertain result reserves those articles **across future buckets**, not just the current one. An acknowledged send sets `sentAt`, which means SMTP acceptance, not guaranteed inbox delivery. Missing SMTP/destination has an actionable error. Error status stays visible in `/api/ebooks`.

After inspecting SMTP logs and stopping an interrupted active sender as appropriate, an operator can reconcile only a `sending`/`unknown` job:

```sh
npm run reconcile-ebook -w @feedink/api -- <ebook-uuid> delivered
npm run reconcile-ebook -w @feedink/api -- <ebook-uuid> not-delivered
```

`delivered` permanently marks it sent; `not-delivered` releases its reservation for a later scheduled bucket. There is no silent automatic resend of an ambiguous external side effect. A fresh explicit manual send is a separate deliberate user action.

## Validation (remote only for this project)

```sh
npm install --ignore-scripts --no-package-lock
npm run build -w @feedink/shared
npm run build -w @feedink/api
NODE_ENV=test TEST_DATABASE_URL=postgres://... npm test -w @feedink/api
```

`audit.test.ts` covers every retained independent review finding, gated ten-way refresh, rollback/crash recovery, import filesystem deltas, bounded export preflight, provenance, bootstrap/stdin secrets, unknown SMTP outcomes across buckets/reconciliation, scheduled folder selection, icons, state fencing and proxy/global/auth rate limits. `network-audit.test.ts` covers gzip/br/deflate expansion/deadlines, mixed DNS answers/pinning and actual ZIP symlink/expansion metadata. Original security/integration suites remain in place, including offline body/image retention, EPUB XML, SMTP fixtures and real static HTTP serving.

Without `TEST_DATABASE_URL`, database suites explicitly skip; that is not a database acceptance pass. Tests own random user IDs, ephemeral HTTP/SMTP listeners and temporary storage, and clean up only those resources. The audit work uses the dedicated `feedink_api_audit_f9b8bac6` database, not the parent's `feedink_test`.

Patched dependency minimums: `@fastify/static` 10.1.11 (its actual plugin metadata requires Fastify **5.x**), `nodemailer` 10.5.0, `sharp` 0.35.5; Node 24 satisfies their published engine ranges. The parent/delivery owns the consolidated root lockfile and final production dependency audit.
