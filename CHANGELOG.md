# Changelog

Version records describe FeedInk changes and verified behavior. Development checkpoints are not production releases.

## 1.0.0 — reading, AI and durable archives

- Complete the reading-first contextual toolbar, focus mode and optional note drawer; keep subscription counts unread-only and normal handwriting placement quiet.
- Support current-article reading-area handwriting, black pen color, received-stroke retention, and confirmed current-version clear-all/ink-only actions without deleting original articles or other body versions.
- Add encrypted per-account OpenAI-compatible settings, explicit full-input summaries, segmented bilingual translation, configuration/source fences, permanent AI results and selected cleanup.
- Add exact transactional article counters and literal-search indexes, preserving existing query semantics and recording scale evidence with dataset/resource limits.
- Add hash-fanout filesystem storage, optional private S3, durable publication/recovery, verified restartable copies, and paired referenced-blob backup/restore under production container restrictions.
- Distinguish disposable build-only development previews from formal release artifacts; Settings displays the running build identifier.
- Provide Docker Compose deployment and migration/key-backup guidance. The final release page supplies the final tag and verification evidence; development checkpoints alone are not release acceptance.

### Reading-first contextual controls

- Replace the in-flow annotation panel with selection-adjacent text actions, an explicit floating handwriting palette and an on-demand note drawer.
- Move reading mode, typography, speech and archive details into contextual reader tools; add opt-in focus reading without changing saved note data.
- Keep healthy connection state compact and suppress install/update prompts while reading or operating dialogs; retain visible recovery for unwritten notes.
- Preserve existing annotation ownership, content snapshots, conditional writes, draft recovery, raw exports and MCP contracts. Validation of this development iteration is recorded in CI, not implied by this changelog.

## 0.2.0 — annotations and read-only AI access — 2026-11-15

- Add reader-scoped text highlights, straight and wavy underlines, remarks, and pressure-aware browser handwriting adapted from Apache-2.0 WebInk.
- Preserve versioned article/mode contexts, including verified contexts opened before an offline draft's first save; use conditional writes and explicit conflict handling.
- Retain unsynchronized drafts during forced authentication loss and non-destructive locked exit. Require verified same-owner recovery and protect notes from legacy browser-cache writers.
- Add restorable JSON, portable Markdown/PNG/JSON archives, and printable annotation reports with raw/unlocated stroke inventories.
- Add archive version 3 note/context restoration, idempotent duplicate handling and missing-image repair while retaining v1/v2 import support.
- Add authenticated Streamable HTTP MCP with seven read-only article/note/image tools, separate scopes, one-time token display, revocation, expiry and disabled-account checks.
- Extend hosted checks with real SDK interoperability, HTTP-level browser fault witnesses, annotation shards, PDF text/raster checks, and note/token persistence through HTTPS deployment recovery.
- Publish hash-inventoried runtime code with required licenses/notices only after all CI gates pass; exclude environment files, archives, credentials and raw diagnostics.

### Verification

Application verification [43724390424](https://github.com/Jasaxion/FeedInk/actions/runs/43724390424), revision `227bbc2`: all 179 automated checks passed (73 API, 82 web, 10 fixture, 4 source-hygiene, 7 backup-format and 3 runtime-package checks). All 57 runnable E2E cases passed, plus the Chromium/WebKit client regression suites. Two WebKit-only trusted-pen/PDF witness slots are covered by actual Chromium tests instead. PDF checks inspect extracted text and rasterized stroke colors. The container job verifies HTTPS authority/origin rejection and notes/token persistence through restart and paired recovery. The release page records final tagged-commit CI; no physical pen/e-ink hardware certification is implied.

## 0.1.0 — base reader — 2026-11-15

- Implement a multi-user Web reader and installable PWA with desktop, tablet, phone and e-ink layouts.
- Add RSS/Atom/JSON Feed discovery, subscription organization, article search, reading state, tags and original demonstration content.
- Persist article bodies, extracted full text and validated image bytes independently of upstream availability.
- Add version-fenced state updates, isolated offline storage, source icons, safe content rendering and browser accessibility controls.
- Add OPML transfer, versioned archive import/export, EPUB generation and operator-configured mail delivery.
- Add operator-only administrator bootstrap, explicit proxy trust, session/CSRF protection, bounded network access and recovery regressions.
- Provide a locked production image, nonroot runtime, Compose health checks and separate database/file volumes.
- Provide consistent paired backups, explicit empty-target restore, integrity checks and non-destructive failure behavior.
- Add automated checks for parsing, concurrency, permissions, storage recovery, PWA behavior, responsive layouts and production deployment.
- Remove reference-source and machine-specific information from public documentation and test defaults. Runtime paths are supplied by environment configuration.

### Verification

Hosted run [43682875301](https://github.com/Jasaxion/FeedInk/actions/runs/43682875301), application revision `3acdec5`, passed both verification and production-container jobs. Reported checks: 47 API, 59 web, 6 fixture, 3 public-content and 7 backup-format tests; all passed with zero skips. The 20 end-to-end cases covered real API behavior, desktop/mobile/tablet/WebKit reading, offline recovery, a complete UI workflow and two-tab state coordination. Docker Engine verified build, secure bootstrap, restart, paired database/file recovery and failure guards.

Browser handwriting, text annotations, note exports and authenticated MCP were added in 0.2.0, not in this historical base release. Test definitions and this record do not certify untested devices, external services or private deployment configurations.
