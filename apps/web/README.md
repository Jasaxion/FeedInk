# FeedInk Web

React / TypeScript / Vite client for the public contract in `docs/api.md`. It does not contain an in-browser imitation API or bundled third-party articles. `test/browser-smoke.mjs` uses an explicitly isolated fixture server solely for frontend regression tests.

## Commands

Run from the repository root after installing workspace dependencies and building `@feedink/shared`:

```sh
npm run dev -w @feedink/web        # Vite :5173; /api -> 127.0.0.1:3000
npm run build -w @feedink/web      # TypeScript check, Vite, versioned offline shell
npm run test -w @feedink/web       # Node tests: IndexedDB, queue, queries, links, SW
npm run test:browser -w @feedink/web
npm run test:audit -w @feedink/web   # Deterministic review-race and pointer-hit regressions
npm run test:shell -w @feedink/web   # Real manifest-only rebuild, SW activation, offline restart
npm run test:images -w @feedink/web  # Portable IDB binary records and offline image decoding
npm run test:offline-origin -w @feedink/web # Owned fixture shutdown and cached restart
```

The browser fixtures need the root Playwright dependency and a production web build. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to existing Chromium, or `FEEDINK_BROWSER=webkit` and the usual Playwright browser/runtime environment. `FEEDINK_PLAYWRIGHT_MODULE` can select an already-installed matching Playwright module; `FEEDINK_BROWSER_ARTIFACTS` selects an external capture directory. `test:shell` temporarily changes only the public manifest and restores it with a final rebuild. In this project's validation environment all dependency installs, builds and browser runs must take place over SSH, not on the operator Mac. Browser captures are evidence artifacts, not source deliverables.

## Reading and privacy

- Public shell files alone enter the service-worker cache. API responses, private images, exports and ebooks never enter its cache.
- A single IndexedDB database keeps an active-owner record. Every private read/write checks that owner in the same transaction. Switching accounts purges the previous account's rows. No CSRF token is persisted.
- Opened/explicitly cached articles and authenticated raster image bytes are scoped to the current user ID. New image rows use `{type, bytes: ArrayBuffer}` rather than Blob/File storage; old bounded raster Blob rows remain readable. `image()` reconstructs a Blob, while rendering/download can use bounded raster data URLs directly from bytes (some WebKit environments reject Blob I/O while offline). No arbitrary data URL or upstream URL is accepted by the stored-image API. An offline list is only locally cached articles, not all server archives.
- Offline changes are small state rows, not whole-body rewrites. Revision-aware acknowledgement preserves newer edits. Owner-scoped Web Locks serialize replay; renewable IndexedDB leases provide fallback coordination. Every state PATCH uses `If-Match: "<stateVersion>"`; expired-lease late writes are fenced by the server. A 412 can only refetch/retry while owner, auth epoch, lease and pending revision remain current. Missing legacy versions require a fresh detail GET. The API must implement this versioned contract; the client does not silently fall back to unsafe unconditional writes.
- Reconnect verifies `/session` and refreshes credentials only, not a stale settings snapshot. Authentication epochs are checked after response parsing and before session/identity effects. Another owner or online 401 fails closed; 429 keeps the session and shows retry guidance. Cache generations prevent cleanup/disable from being undone by late writes. Cached read counts and newer acknowledged state overlays survive stale library/body responses.
- Logout attempts local purge and server revocation independently. Offline revocation retries on reconnect/focus as well as startup; a newer login invalidates an old retry. Failed purge or account-cache activation leaves a blocking marker rather than restoring an old owner's private cache. Other tabs are informed through BroadcastChannel. Optional cache/quota failures are reported without undoing successful online operations; failed offline mutations are never shown as saved.
- Browser quota/eviction is separate from the server's durable PostgreSQL/image-volume archive. Cache failures remain visible. Settings include a persistent-storage request and local cache cleanup.

## Content boundaries

HTML is sanitized again with DOMPurify before rendering. It cannot insert scripts, frames, forms, IDs, arbitrary classes or inline styles. Article HTML images use only same-origin `/api/assets/<opaque-id>` paths. Source-specific icons additionally accept only exact `/api/feed-icons/<UUID>` paths, with a generic glyph fallback. Original links open with `noopener noreferrer`. Original-page mode renders a separate empty-sandbox iframe (no scripts, same-origin privileges, popups or top navigation), with an always-visible external fallback for framing-denied/script-dependent sites and an explicit offline-unavailable state. Article HTML itself cannot insert frames.

Custom CSS accepts only an element-selector and declaration whitelist, prefixed to `.article-content`. URL loads, imports, variables, escaped selectors, positioning and active content are rejected. E-ink ignores custom CSS, forces black/white high contrast and enlarged pagination, and disables effects. Reduced-motion is respected independently.

## Integration boundaries

Authentication, feed discovery/refresh, durable full-text/image capture, OPML/ZIP recovery, EPUB generation, SMTP delivery and scheduling use real server endpoints. Frontend-only tests do not prove these backend functions. Use the independent repository API/security and end-to-end suites for that acceptance gate.

SpeechSynthesis voices and external podcast codecs depend on the browser; no native-app package is produced. Podcasts remain externally streamed rather than claiming offline media archiving. Installation requires HTTPS or localhost. The image viewer supports explicit zoom/fit, native browser/pinch zoom and cached-image download. RSSHub is selected by entering the full URL of a user-chosen instance; there is no undocumented settings field or fixed third-party proxy.
