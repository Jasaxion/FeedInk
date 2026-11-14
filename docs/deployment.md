# Deploying FeedInk

FeedInk targets multi-user self-hosted **Web + installable PWA**, not native apps. React/TypeScript builds into a SPA served by the Node 24 API. PostgreSQL holds accounts, article bodies/state and migration history; an **independent `/data` volume** holds archived image bytes and generated files. Keep both. The behavioral contract in [reference.md](reference.md) is an acceptance target, not a claim that every scenario has passed.

## Requirements

- Docker Engine with Docker Compose v2 (or a compatible Podman Compose provider; see caveats below).
- A DNS name and an HTTPS reverse proxy for non-local use.
- Sufficient disk for database **and indefinitely retained archives**. Monitor both volumes and keep an off-host backup. No automatic retention policy should be assumed.
- For source development only: Node 24.22.3 and npm 11. The production host does not need Node, npm or PostgreSQL clients.

## First deployment

From a checkout that includes `package-lock.json`:

```sh
cp -f .env.example .env
chmod 600 .env
openssl rand -hex 32  # paste into POSTGRES_PASSWORD
openssl rand -hex 32  # a DIFFERENT value for SESSION_SECRET
```

Edit `.env`: set the externally visible `APP_URL` (origin, no trailing path), the secrets, and the project name. The database password in this Compose file is interpolated into a URL: use generated hexadecimal characters, not URL punctuation. Never commit `.env`, paste secrets into issue reports, or publish `docker compose config` output.

```sh
docker compose build --pull
docker compose up -d --wait --wait-timeout 120 postgres
# Bootstrap the administrator using the private-file procedure below, BEFORE public access.
# Then start the application:
docker compose up -d
# /api/health must report database: ok, not just an open TCP socket.
curl --fail http://127.0.0.1:3000/api/health
docker compose ps
```

Only the app is published, to `127.0.0.1:3000` by default. PostgreSQL has **no public port**. The app runs as uid/gid 1000 with a read-only root filesystem, writable `/data` and bounded `/tmp`; it has no extra capabilities and no container socket. Named volumes are initialized with the image directory ownership. For bind mounts, provision a real directory writable by uid1000; rootless Podman UID mapping differs. Do not fix permissions with world-writable directories or by running the application as root.

## Operator-only administrator bootstrap

Leave `REGISTRATION_ENABLED=false`. Set `ADMIN_EMAIL` and `ADMIN_NAME` in the private `.env`; these identify the operator CLI's account, **not** an email-based registration privilege. Public registration never creates an administrator, even if the submitted email matches `ADMIN_EMAIL`.

Prepare a strong password in a private file outside the checkout using a password manager, or generate one without terminal/log output:

```sh
# /secure must already be a private directory you control.
umask 077
openssl rand -base64 32 > /secure/feedink-admin-password
chmod 600 /secure/feedink-admin-password
# PostgreSQL must be running; the CLI applies migrations under the normal database lock.
docker compose run --rm --no-deps -T -e ADMIN_PASSWORD_FILE=/dev/stdin \
  --entrypoint npm app run bootstrap-admin -w @feedink/api < /secure/feedink-admin-password
```

This starts a temporary nonroot application container **without service ports**, streams the password on stdin, and does not mount a host secret file or Docker socket. The special `/dev/stdin` source is bounded by the CLI. The password is never an argument or environment value. No host Node installation is needed. Keep the source file private, transfer the password to your password manager, and do not enable shell tracing or publish command logs containing secrets. Do not put this password in `.env`.

Bootstrap is an atomic one-time creation operation: it refuses an existing email or an already-active administrator. It does not promote an existing ordinary user and is not an account-recovery/reset command. A refusal should be investigated rather than bypassed with public registration or database edits. Start the public app and reverse proxy only after successful bootstrap. Ordinary user registration can subsequently be enabled deliberately; disabling it does not disable existing logins.

## SMTP and uncertain delivery

SMTP is optional: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` only if mail delivery is desired. Use a restricted sender account. TLS-on-connect usually uses port465/`SMTP_SECURE=true`; submission/STARTTLS usually uses587/false. Never treat an absent SMTP configuration as a successful send.

An interrupted SMTP transaction can leave an ebook in an **unknown delivery** state: the server may have accepted it before the connection failed. Do not automatically resend, mark it delivered merely because a connection succeeded, or edit the database to clear the state. First inspect your SMTP provider's delivery log using the ebook/message metadata. Then reconcile that specific ebook with the operator-only CLI:

```sh
docker compose run --rm --no-deps -T --entrypoint npm app run reconcile-ebook -w @feedink/api -- \
  <ebook-uuid> delivered
# Or, only after confirming the message was not delivered:
docker compose run --rm --no-deps -T --entrypoint npm app run reconcile-ebook -w @feedink/api -- \
  <ebook-uuid> not-delivered
```

Replace `<ebook-uuid>` with the real opaque identifier (do not type the angle brackets). The CLI records an operator conclusion; it does not prove delivery by itself. Treat `not-delivered` as permission for a subsequent retry according to the application's queue state; keep workers paused during investigation if a duplicate would be harmful. Never use real recipients for a recovery drill.

## HTTPS reverse proxy

Example Caddy configuration on the Docker host:

```caddyfile
reader.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `APP_URL=https://reader.example.com`. Caddy manages certificates and preserves the original host and forwarded protocol. Also configure `TRUST_PROXY` to the **actual proxy socket-peer IP or tightly scoped dedicated proxy CIDR seen by the API**. Empty/unset means `false`: forwarded client addresses are ignored, so clients behind that proxy share its IP-based rate-limit bucket. The parser accepts only comma-separated, trimmed literal IPv4/IPv6 addresses or CIDRs; it rejects keywords, hop counts and universal `0.0.0.0/0` or `::/0` trust. Never configure trust-all forwarding.

For a proxy inside a container, assign/inspect its address on a dedicated network and trust only that proxy address or an exclusively proxy-controlled subnet. For a host proxy forwarding through Docker's published port, the API commonly sees the bridge gateway rather than `127.0.0.1`; rootless providers may differ. Inspect the actual socket peer in a controlled request before choosing the allowlist. Do not assume the browser's IP or a supplied `X-Forwarded-For` header is that peer. Restrict direct access to the application port to the proxy/trusted host, and ensure the edge proxy replaces client-supplied forwarding headers.

After changing the env, recreate the app. Validate through the real proxy that two client addresses receive independent rate-limit budgets, and that an untrusted direct peer cannot escape limits by changing `X-Forwarded-For`. The API regression suite tests this trust boundary; production Compose smoke alone is not a reverse-proxy test. With nginx or another proxy, forward `Host` and `X-Forwarded-Proto`, support ordinary streaming responses, and permit the upload/download sizes you intend to allow. Do **not** add public CDN caching for `/api/`, authenticated image assets, archive downloads or ebooks. Keep the API same-origin; do not enable wildcard credentialed CORS. If the proxy itself runs in a container, `127.0.0.1` means that container: attach it to an explicitly chosen Compose network and proxy `app:3000`, or use a host gateway you control. Do not publish PostgreSQL to solve proxy networking.

For a local-only smoke test use `APP_URL=http://localhost:3000`. An HTTP LAN address is not a secure PWA context; use HTTPS for phones/tablets. If cookies are configured Secure, test login through HTTPS instead of bypassing the proxy. Do not weaken production cookies to make an insecure remote origin work.

## PWA installation and updates

Open the HTTPS origin in a supported browser and use its **Install app / Add to Home Screen** command. On iOS/iPadOS use Safari's Share → Add to Home Screen. Browser installation prompts and background/offline capabilities vary by platform; there is no APK/IPA/desktop installer.

Before relying on offline reading, open/cache articles and their images while online, then test in airplane mode. A PWA is not a backup: browser storage can be evicted and uncached articles cannot be fetched offline. Verify a logout or account switch clears prior-user private caches and pending changes. Do not promise an offline image was captured if its status is failed. After an upgrade, accept the application's update prompt or close/reopen the PWA; test the service-worker update path before a release.

## Development

```sh
npm ci
npm run build -w @feedink/shared
# Start a dedicated development PostgreSQL instance; do not use production data.
# Export DATABASE_URL, DATA_DIR, APP_URL and SESSION_SECRET in your shell.
npm run dev:api
# A second terminal:
npm run dev:web
```

The API defaults to port3000; the web development server must proxy `/api` to it. Read the actual Vite configuration for its port. Keep `APP_URL` equal to the browser-facing development origin for CSRF checks. `DATA_DIR` must be an absolute writable directory separate from source. The production build order is shared → web → API (`npm run build`). Do not commit `node_modules`, `dist`, `.env`, article archives or captures.

To use Compose PostgreSQL from a host development process, add a **local-only** override publishing `127.0.0.1:<unused-port>:5432`; do not edit the production default or publish it on all interfaces. A host process cannot reach the Compose service name `postgres`.

## Migration, upgrade and rollback

API startup applies `apps/api/migrations` under a database lock before serving. Do not edit an already-applied migration. Run one upgrade first; verify its health before allowing traffic. Never assume an older binary can read a newer schema.

1. Record the current source revision, exact app image ID/digest and PostgreSQL major version. Keep the old image locally or in a private registry. `feedink:local` alone is not a rollback record.
2. Stop **every** API/worker instance and external writer. Take and verify the paired backup described in [backup.md](backup.md). Leave the app stopped on backup failure.
3. Build/tag the new image with a distinct immutable version. Set `FEEDINK_IMAGE` in the private env file. Keep the PostgreSQL major version unchanged during an app upgrade.
4. Start the new app. Check `/api/health`, logs without secrets, login, existing article bodies/images, a new capture and worker activity.
5. If a schema-compatible app rollback is explicitly supported, select the retained old image. Otherwise restore the **pre-upgrade bundle into a fresh project** using the old image, verify it privately, then switch the reverse proxy. Preserve the failed deployment for investigation; do not run `down -v` on production.

PostgreSQL major upgrades need a separate tested `pg_dump`/`pg_restore` or `pg_upgrade` procedure. Do not point a new major image at the old data directory. Restore tools must support the dump server version. Backups do not contain the operator env file: escrow secrets/configuration securely and separately.

## Podman / restricted networks

The validation environment uses rootless Podman behind the `docker` command and Docker Compose v2, not Docker Engine. Socket activation, service-name DNS, health checks and volume UID mapping depend on the provider; validate them on your target host. If building with Podman, use `podman build --format=docker` to retain the Dockerfile health check (the Compose health check is specified separately). A missing DNS helper or broken automatic health runner is a host compatibility issue: do not remove production health dependencies or publish the database as a workaround. See [testing.md](testing.md) for the narrowly scoped preliminary test workaround and its limits. If Docker Hub is inaccessible, set the image variables to equivalent **official** mirrors, for example `public.ecr.aws/docker/library/node:24.22.3-bookworm-slim` and `public.ecr.aws/docker/library/postgres:17-alpine`. Avoid untrusted replacement images. CI checks standard Docker; remote Podman validation is a distinct piece of evidence, not a Docker Engine claim.
