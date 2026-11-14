# Changelog

Version records describe FeedInk changes and verified behavior. Development checkpoints are not production releases.

## 0.1.0 — initial implementation (unreleased)

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

Release acceptance remains in progress. The repository's CI and reviewed validation summaries determine release readiness; source descriptions and test definitions alone are not proof that every scenario passed.
