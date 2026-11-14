# FeedInk Web

React / TypeScript / Vite client for the public contract in `docs/api.md`. It does not contain an in-browser imitation API or bundled third-party articles. `test/browser-smoke.mjs` uses an explicitly isolated fixture server solely for frontend regression tests.

## Commands

Run from the repository root after installing workspace dependencies and building `@feedink/shared`:

```sh
npm run dev -w @feedink/web        # Vite :5173; /api -> 127.0.0.1:3000
npm run build -w @feedink/web      # TypeScript check, Vite, versioned offline shell
npm run test -w @feedink/web       # Node tests: IndexedDB, queue, queries, links, SW
npm run test:browser -w @feedink/web
```

The browser fixture needs the root Playwright dependency, a production web build, and Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary. In this project's validation environment all dependency installs, builds and browser runs must take place over SSH, not on the operator Mac. Browser captures are evidence artifacts, not source deliverables.

## Reading and privacy

- Public shell files alone enter the service-worker cache. API responses, private images, exports and ebooks never enter its cache.
- A single IndexedDB database keeps an active-owner record. Every private read/write checks that owner in the same transaction. Switching accounts purges the previous account's rows. No CSRF token is persisted.
- Opened or explicitly downloaded articles and their authenticated raster image blobs are cached under the current user ID. An offline list is only a list of locally cached articles, not a claim that all server archives are present.
- Offline changes are merged idempotent state assignments. Each entry has a revision so edits made during a network request cannot be discarded by acknowledgement of an older revision. Reconnect first verifies `/session`; each mutation uses that session's CSRF token. A different server identity or online 401 fails closed.
- Logout immediately clears private data. If the network cannot revoke the cookie, a local logout marker prevents automatic offline/session restoration and retries server logout on the next load. Other tabs are informed through BroadcastChannel.
- Browser quota/eviction is separate from the server's durable PostgreSQL/image-volume archive. Cache failures remain visible. Settings include a persistent-storage request and local cache cleanup.

## Content boundaries

HTML is sanitized again with DOMPurify before rendering. It cannot insert scripts, frames, forms, IDs, arbitrary classes or inline styles. Only same-origin `/api/assets/<opaque-id>` image sources render; original links open with `noopener noreferrer`. Original-webpage mode intentionally uses an external tab instead of embedding an untrusted page in the authenticated application.

Custom CSS accepts only an element-selector and declaration whitelist, prefixed to `.article-content`. URL loads, imports, variables, escaped selectors, positioning and active content are rejected. E-ink ignores custom CSS, forces black/white high contrast and enlarged pagination, and disables effects. Reduced-motion is respected independently.

## Integration boundaries

Authentication, feed discovery/refresh, durable full-text/image capture, OPML/ZIP recovery, EPUB generation, SMTP delivery and scheduling use real server endpoints. Frontend-only tests do not prove these backend functions. Use the independent repository API/security and end-to-end suites for that acceptance gate.

SpeechSynthesis voices and external podcast codecs depend on the browser; no native-app package is produced. Podcasts remain externally streamed rather than claiming offline media archiving. Installation requires HTTPS or localhost. The image viewer supports native browser/pinch zoom and cached-image download. RSSHub is selected by entering the full URL of a user-chosen instance; there is no undocumented settings field or fixed third-party proxy.
