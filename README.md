# FeedInk

An independently implemented RSS reader for **multi-user self-hosted Web and installable PWA**, built with React/TypeScript, Node24 and PostgreSQL. The target is a focused three-pane reading experience across desktop, tablet, phone and e-ink devices, with durable article bodies and independently stored image bytes—not a browser-only feed demo or an upstream image proxy.

FeedInk is independently developed and ships original demonstration content. The [product requirements](docs/requirements.md) describe its own behavior. Install the PWA through a compatible browser; no native platform packages are included.

## Version 0.1.0 — base reader

The base reader passed its [complete hosted verification](https://github.com/Jasaxion/FeedInk/actions/runs/43682875301): 122 automated checks and 20 real API/browser end-to-end cases, plus production Docker startup, administrator bootstrap, restart and paired database/file recovery.

This version includes reading, subscriptions, durable archives, PWA/offline behavior and e-ink layouts. **Article annotations, handwriting and MCP access are the next development phase, not features claimed for 0.1.0.** Read [testing and evidence limits](docs/testing.md) and [CHANGELOG.md](CHANGELOG.md); maintain independent backups and do not assume every publisher or hardware device behaves identically to the tested fixtures.

## Run with Docker Compose

```sh
cp -f .env.example .env
chmod 600 .env
openssl rand -hex 32  # use as POSTGRES_PASSWORD
openssl rand -hex 32  # use a separate value as SESSION_SECRET
# Edit .env: secrets, APP_URL, ADMIN_EMAIL and ADMIN_NAME; leave registration closed.
docker compose build
docker compose up -d --wait postgres
# Prepare a private password file outside the checkout, then bootstrap without publishing a port:
docker compose run --rm --no-deps -T -e ADMIN_PASSWORD_FILE=/dev/stdin \
  --entrypoint npm app run bootstrap-admin -w @feedink/api < /secure/feedink-admin-password
docker compose up -d
curl --fail http://127.0.0.1:3000/api/health
```

Use HTTPS through a reverse proxy for remote access/PWA installation. The app binds to loopback3000 by default; PostgreSQL has no published port. PostgreSQL and `/data` have **separate persistent volumes** and must be backed up together. Registration defaults closed. [Deployment instructions](docs/deployment.md) cover operator-only administrator bootstrap, explicit reverse-proxy trust, SMTP, source development, ownership, migrations, versioned upgrades and rollback.

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [API/shared contract](docs/api.md)
- [Annotation and MCP development contract](docs/annotations-api.md)
- [Annotations, offline drafts and recovery (development)](docs/annotations.md)
- [JSON, Markdown and PDF note exports (development)](docs/notes-export.md)
- [Scoped read-only MCP access (development)](docs/mcp.md)
- [Product requirements and acceptance](docs/requirements.md)
- [Deployment, HTTPS and PWA](docs/deployment.md)
- [Consistent backup and empty-target restore](docs/backup.md)
- [Security and operator responsibilities](docs/security.md)
- [Tests, CI and validation limits](docs/testing.md)
- [Version history](CHANGELOG.md)
- [0.1.0 release notes](docs/releases/0.1.0.md)

The current development workspace builds `packages/ink` → `packages/shared` → `apps/web` → `apps/api`. Annotation components are adapted from the authorized Apache-2.0 WebInk source; see [NOTICE](NOTICE). The reusable engine does not by itself mean the new annotation UI/API is released. Development requires Node24.22.3/npm11 and a dedicated PostgreSQL database. The production host requires Docker+Compose, not a host Node installation. See [LICENSE](LICENSE) for the repository license.
