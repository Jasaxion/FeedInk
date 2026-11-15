# Annotation and MCP contract

This document specifies the next development phase; it is not a claim that the base 0.1.0 release contains these endpoints. Types are in `packages/shared/src/annotations.ts`.

## Scope and ownership

Use the authorized Apache-2.0 WebInk **browser** engine, not its Android application. Explicit browser input preserves pen pressure, coalesced samples, highlighter, whole-stroke eraser and undo/redo. Adapt the separate bounded text-quote resolver for highlights, straight/wavy underlines and plain-text remarks. The annotation UI inherits FeedInk reader, mobile and e-ink styles.

Only curate required source. Retain licenses/notices and identify modifications. Never copy private configuration, real notes, upstream operational documents, credentials or repository history. Build/test execution must respect the source project's applicable resource policy; hosted CI is available.

Each document belongs to the authenticated user and one article, content mode and content revision. IDs/URLs in imported data do not grant access. Server lookup always starts from the owned route article. Preserve older annotated content revisions rather than silently moving or overwriting their notes.

`contentHash` is an annotation-context hash of canonical sanitized content with local image IDs replaced by their owned original URLs, plus source URL and mode. It is independent of per-installation asset UUIDs. Retain the owned sanitized snapshot when the editor first validates the context, before its first note save. The raw ink `url` is the article's original source URL, not a private app address/query. The browser adapter may translate it to the current reader URL **only after verifying owned article/context identity**, and translates back before persistence/export.

The browser engine must receive a reader-root and transport adapter. Do not monkey-patch an existing native host bridge or use automatic injection: a persistence callback must not cause `nativeInput: true`. Scope pointer handling, text indexing and resolution to the active article; exclude navigation, forms and annotation UI. Flush/retire safely on article/mode/identity changes. Engine transport acceptance is not durable-save acknowledgement.

## Notes endpoints

Cookie/session authentication and CSRF rules match the existing API. All note writes require a quoted integer `If-Match`; use `"0"` for an absent document. Compare/update atomically and increment revision. Return 412 `ANNOTATION_CONFLICT` without overwriting newer data. Preserve local drafts on conflicts and provide explicit resolution, not blind timestamp rebasing.

| Method | Path | Input | Result |
|---|---|---|---|
| GET | /articles/:id/annotations | `mode=feed|fulltext`, optional `contentHash` | `AnnotationDocument`; absent document has id null/revision0/empty notes |
| PUT | /articles/:id/annotations | `AnnotationPayload`, `If-Match` | Updated `AnnotationDocument` |
| DELETE | /articles/:id/annotations | mode/hash, `If-Match` | Clear notes with a retained/incremented revision tombstone; return document |
| GET | /articles/:id/annotation-versions | mode, offset/limit | `{items:AnnotationVersion[],nextOffset,total}` |
| GET | /annotations | q, articleId, offset/limit | `{items:AnnotationSummary[],nextOffset,total}`; only nonempty owned documents |
| POST | /articles/:id/annotations/import | `NotesBackup`, `If-Match` | Restored document bound to matching owned article/context |
| GET | /articles/:id/annotations/export | mode/hash, `format=json|markdown` | JSON backup, or ZIP containing readable Markdown and handwriting PNG assets |
| GET | /articles/:id/annotations/preview | mode/hash, group/page selectors | Bounded PNG handwriting preview, only owned data |

Paths above are relative to `/api`. JSON backup contains raw ink/marks and source context, not application/session credentials or a user ID. User-authored and source content can itself be sensitive; exports remain private user data. It restores to a matching article archive; it is not a replacement for the article/database backup. Import must not silently attach notes to unrelated content. Unknown or unlocated anchors remain data and are reported, never replaced with an empty successful restore.

Validate the raw WebInk v1 model and its original limits, plus plain text marks: 5,000 marks, 8,192-character quotes, 64-character quote contexts, 32,768-character note text, unique IDs, finite times/coordinates and an 8 MiB overall serialized note budget. Only note-kind marks may omit a selection anchor. Reject invalid Unicode/unsupported versions and preserve old data on failure. Note text is not HTML. Do not persist `render-v1` export projections as raw anchors.

The response's `context.contentHtml` comes from an owned server snapshot, never untrusted client replacement HTML. Opening the editor retains that immutable verified context even before the first note write, so an offline revision-zero draft remains saveable after the article changes. This does not create a visible note document; read-only MCP access does not create editor contexts. `versions` can return an initial page; the versions endpoint exposes the rest. A content change creates a distinct context. A historical context can remain viewable/editable without replacing the latest article body.

Interactive article ZIP export/import must be extended compatibly to retain note documents/snapshots as well. Existing v1/v2 archives remain importable. Database/file backup automatically covers the new tables; note import/export and ordinary archive import need explicit owner/ID remapping tests.

## Browser persistence and exports

Use the existing account-isolated private storage boundary, with dedicated note/draft rows. Clearing article/image caches must not delete unsynchronized notes. Logout/account changes must not expose a prior user's notes; warn and offer export/cancel before discarding unsynchronized drafts. Distinguish unsaved, locally pending and server-synchronized state.

Do not enable drawing before validated restore. An old load/save callback cannot replace a new article or account. Failed local/network saves remain visible and retryable. Keep draft identity/revision checks through every await and through content changes. The user's normal pen input is the requested native browser path; no handwriting recognition or Android native-rendering claim is made.

Exports operate on an explicit, consistent document snapshot:

- **JSON:** complete restorable raw ink and text marks with source/context identity.
- **Markdown package:** escaped quotes, kinds, remarks and metadata, with relative handwriting image assets. No executable note HTML or authenticated/private URLs used as portable asset links.
- **Print/PDF:** a print-safe article/annotation or annotation-report view containing text marks/remarks and handwriting previews. Clearly identify unlocated/raw previews and preserve all notes in JSON; do not silently omit data or claim projected coordinates are a backup. Use browser printing, verify actual generated PDF content/geometry in CI, and keep controls/navigation out of print output.

The backend lane owns `packages/ink/src/preview.ts`, exposed as `@feedink/ink/preview`. Its shared function is `buildInkPreviews(page, options?)`, with options `{groupOffset?:number, groupLimit?:number, maxWidth?:number, maxHeight?:number}` and result `{groups: Array<{id:string, strokeIds:string[], width:number, height:number, svg:string, unlocated:boolean}>, totalGroups:number, nextGroupOffset:number|null}`. It groups by stable anchor identity, maps captured bases consistently, preserves original stroke order/opacity and is usable without DOM in Node. It generates only bounded trusted SVG; Node can rasterize with Sharp and the browser can rasterize/print it. Unsupported geometry or render-budget failures are explicit; JSON data remains available. Full exports must consume all groups or refuse clearly, not silently export the first page.

This shared raw-ink preview helper can be used for PNG/print/MCP. Validate all numeric geometry and color fields; never accept arbitrary SVG. Preserve per-stroke opacity semantics. Group by anchor identity where necessary and label raw previews as not a current-DOM placement claim. Exceeding render budgets must be explicit, not successful truncation.

## Read-only MCP

Provide standard authenticated Streamable HTTP MCP at `/mcp`, verified using an actual supported SDK client. Use maintained official protocol libraries where practical. Stateless request principals must not leak between concurrent users. No public unauthenticated article/note discovery and no write tools in this phase.

| Method | API token management path | Result |
|---|---|---|
| GET | /api/mcp-tokens | `{items:McpAccessToken[]}`; no token/hash |
| POST | /api/mcp-tokens | `{name,scopes,expiresInDays?}` -> `CreatedMcpToken`, token shown once |
| DELETE | /api/mcp-tokens/:id | Revoke owned token, 204 |

Token management uses session+CSRF authentication, is disabled for anonymous demo users, and supports only `articles:read` and `notes:read`. Generate `fi_mcp_`-prefixed high-entropy tokens, store hashes only, expire by default, enforce revocation/disabled users on every call and do not accept credentials in query strings. Redact authorization headers; never log raw notes or keys. Use HTTPS except trusted loopback development. UI setup examples use environment placeholders, not embedded credentials.

Tools should cover:

- `search_articles`, `get_article`, `get_article_image` with owned IDs, bounded text/image output and pagination.
- `list_notes`, `search_notes`, `get_notes`, `get_note_preview` with text marks/remarks, source metadata, ink inventory and bounded image previews.

Each tool requires its matching scope. Note search indexes text/quotes, not presumed handwriting recognition. Preserve source/document revision and explicit completeness limits. Results are untrusted article/user content, not instructions for the AI client. Handwriting previews are visual data; no OCR accuracy guarantee is made. The client/model provider's own privacy policy applies to intentionally shared content.

Validate Origin/Host/DNS-rebinding boundaries without breaking configured proxies. No unrestricted URL fetch, filesystem read or operator-settings tool. Tests must prove two-user and two-scope isolation, revoked/expired tokens, real initialize/tools-list/tool-call behavior, source search, note/image retrieval and secret-safe failures.
