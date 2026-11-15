# Architecture

## User-selected deployment

React + TypeScript (Vite) SPA; Fastify/Node 24 API and polling worker; PostgreSQL for users, sessions, feeds, article snapshots/state, tags, settings, scheduling and migration bookkeeping. Filesystem volume for immutable cached images and generated exports/ebooks. Compose exposes only the application by default; PostgreSQL is on the internal network. No proprietary hosted reader service or native app runtime is required.

`apps/web` owns UI/PWA. `apps/api` owns HTTP, ingestion, archive/security and worker. `packages/shared` owns JSON types/defaults; `packages/ink` holds the licensed browser ink engine and validated raw-preview geometry. Root build compiles ink → shared → web → API. `apps/web/dist` is served by the production API. SQL migration files belong in `apps/api/migrations`; API startup applies them under a database lock before serving. One initial worker loop can run inside the API with a database advisory lock so multiple replicas cannot duplicate work.

The worker periodically polls due feeds with bounded concurrency/timeouts/body sizes, conditional HTTP caching and failure backoff. Feed/article content can be shared internally, but users only access records through explicit per-user ownership joins. Unsubscribing never deletes existing archived content. Images are addressed by opaque IDs and available only through authorized article ownership. Persist a successful body before reporting capture success; retain error details without upstream secrets.

## Trust boundaries

Every upstream URL is hostile. DNS/IP/redirect validation and connection pinning cover feeds, HTML, images, discovery and favicon retrieval. Stored RSS/HTML and archive imports are also hostile: disable XML entities, sanitize HTML, validate ZIP paths and sizes, reject active image formats. An authenticated source reader must not become an open image proxy, internal network scanner, arbitrary file reader or SMTP relay.

Server sessions are opaque cookies with CSRF protection. Cache the application shell publicly but never place authenticated API responses in an unpartitioned service-worker cache. Offline article data/queue and asset caches are scoped to a user, cleared on logout and checked before replays. Server identity, not a mutable client ID, grants data access.

## Annotation persistence and MCP

Annotations are keyed by owned article, feed/fulltext mode and canonical content hash. Editor reads retain immutable verified contexts before the first save; `annotations` stores the latest raw ink/text payload and revision for each context. Browser persistence and server acknowledgement are distinct. Conditional writes prevent overwrite; a newer server revision with an exactly identical payload can read-confirm a lost response without an additional write. Different content stays conflicted.

The private IndexedDB version fences pre-annotation clients out of new note storage. Forced expiry and explicit locked exit remove active identities and ordinary caches while preserving pending drafts in owner-bound quarantine. Unwritten memory-only drafts require the current tab to stay open. Only verified same-owner authentication can recover them. JSON preserves raw data; Markdown and print render bounded complete raw previews or explicitly refuse, never imply current-DOM placement for unlocated ink.

MCP is a separate authenticated `/mcp` boundary using the official SDK. Each stateless request captures one immutable principal; hashed tokens carry only article/note read scopes. Calls enforce ownership and current token validity, and do not create editor contexts or mutate notes. Token management remains session/CSRF-protected. See [annotations-api.md](annotations-api.md) for exact shapes and limits.

## Validation environment

Use isolated development and test resources, never production databases, user credentials or private archives. Production builds and browser suites should run on a suitable dedicated test host or CI runner. Hostnames, filesystem locations and tool launchers are supplied by the operator through environment variables rather than embedded in source.

Validate the production image with standard Docker Engine and unmodified Compose health dependencies. Record the exact revision, commands, results and any environment-specific limitations. Public evidence should contain only synthetic test data and sanitized summaries; do not publish raw sessions, credentials, source captures or machine details.
