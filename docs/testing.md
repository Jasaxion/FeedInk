# Validation and release gates

Use an isolated test host/workspace with Node24.22.3, npm11, PostgreSQL17 and sufficient disk. Do not run these against production users, SMTP recipients or archives. Repository policy delegates heavy dependency installation, production builds and browsers to a separate compute host; SSH hostnames and private paths are operator configuration, not application requirements. When copying from macOS, use `COPYFILE_DISABLE=1 tar --no-xattrs` or exclude `._*` with rsync so AppleDouble files cannot become fake TypeScript tests.

## Automated commands

```sh
npm ci
# Integration tests execute the compiled operator CLI, so build all workspaces first.
npm run build
npm run typecheck
npm audit --omit=dev --audit-level=moderate
# Supply a dedicated disposable PostgreSQL URL; absent TEST_DATABASE_URL skips API integration.
export TEST_DATABASE_URL='postgresql://test_user:TEST_PASSWORD@127.0.0.1:5432/feedink_test'
npm test
node --test scripts/data-archive.test.mjs
for script in scripts/*.sh; do sh -n "$script"; done
```

`npm test` runs workspace tests and the first-party upstream fixture self-tests when included in the root script. Inspect output for **skipped** database integration tests; a green no-database run is not integration evidence. Backend integration and browser suites must not mutate the same database concurrently. Never substitute real SMTP delivery for a mail fixture.

For the parent-owned Playwright suite:

```sh
npx playwright install --with-deps chromium
# In a separate shell, configure and start the built API.
# DATABASE_URL, SESSION_SECRET, DATA_DIR and APP_URL are required for a production-like run.
# These are test-only private-host permissions; keep production FETCH_ALLOW_HOSTS unset.
export FETCH_ALLOW_HOSTS=127.0.0.1
export APP_URL=http://127.0.0.1:3000
node apps/api/dist/server.js
```

Then in the test shell:

```sh
BASE_URL=http://127.0.0.1:3000 \
FEEDINK_FIXTURE_URL=http://127.0.0.1:8899 \
npm run test:e2e -- --project=desktop
```

Run `api`, `desktop`, `mobile`, `tablet`, `workflows`, and optionally `webkit` separately, restarting only your own API process between projects. Combined browser projects share the same loopback rate-limit identity and can legitimately exhaust a minute's budget; do not disable or raise production limits to hide this. CI starts `node apps/api/dist/server.js` directly per project, uses bounded readiness, and terminates/waits for only its captured child PID. It installs both Chromium and WebKit and sets `FEEDINK_TEST_WEBKIT=1`.

For WebKit, the PWA test injects actual browser HTTP failures plus the corresponding connectivity event instead of using the WPE protocol offline toggle, which can fail navigation before a service worker runs. The test separately verifies that browser HTTP cannot reach the API, cached shell/body/images reload, the server has not received offline edits, and reconnect sends them. Chromium retains its protocol-level offline test. Neither method is a hardware airplane-mode certification; no offline assertion is skipped.

Playwright starts `tests/fixtures/upstream.mjs` via `webServer`; do not launch a duplicate fixture. If the fixture port is occupied, choose your own free port and set **both** `FEEDINK_FIXTURE_PORT` and `FEEDINK_FIXTURE_URL` consistently; never kill an unknown listener. The API is started separately and must reach that fixture URL. Configure the API's allowlist before launching it. For optional WebKit coverage, install WebKit and set `FEEDINK_TEST_WEBKIT=1`; do not report WebKit coverage when only Chromium ran. Browser screenshots/traces are private diagnostic output, not committed source or proof that unrelated scenarios passed.

## Container and recovery checks

```sh
docker build -t feedink:test .
# Select the image just built rather than an older feedink:local from .env.
export FEEDINK_IMAGE=feedink:test
# Requires .env with generated secrets; config --quiet avoids printing credentials.
docker compose config --quiet
docker compose up -d --wait
curl --fail http://127.0.0.1:3000/api/health
TEST_IMAGE=feedink:test scripts/test-backup.sh
# Optional application-level fixture (Node24 test driver, not a production host dependency):
BASE_URL=http://127.0.0.1:3000 STATE_FILE=/private/test-state.json node scripts/test-deployment.mjs seed
# Restart app, or restore its paired backup into a fresh project, then use the same STATE_FILE:
BASE_URL=http://127.0.0.1:3000 STATE_FILE=/private/test-state.json node scripts/test-deployment.mjs verify
```

The application test creates an isolated first-party demo account and records body/image hashes. `STATE_FILE` contains its live session cookie: keep it private and outside the checkout, and never upload it as evidence. It checks the SPA, manifest, service worker response, database health, article count, body/image byte hashes and unauthenticated asset denial. It does **not** install a PWA or exercise browser offline behavior.

The recovery drill uses a first-party SQL body and four binary bytes, **new uniquely named Compose projects**, no published PostgreSQL ports and separate data/database volumes. It checks running-app refusal, no overwrite, explicit restore confirmation, bundle symlinks including trailing-slash spellings, exact SQL/body-byte restoration and nonempty database/data refusal. Database fixtures include a function-only database, a collation-only database, a handler-free foreign-data wrapper, a cast between built-in types and an explicitly low-OID large object. Refusals check the expected diagnostic and verify no application table or file was restored. The checksum regression flips a payload byte **without changing framing**, independently validates the modified archive's framing, and uses a new empty target; it requires `Backup checksum mismatch` and verifies both stores remain empty. It stops its own projects and reports their names and private evidence directory; it does not delete evidence or volumes. Review and remove only those exact test resources afterward if desired, never prune shared host resources. The archive utility tests cover traversal, symlinks, conflicting paths, truncation, unknown versions/fields and size bounds.

The GitHub workflow runs unit/type/build/database tests with `TEST_DATABASE_URL` and a PostgreSQL service, isolated-per-project Chromium/WebKit acceptance, and a separate hosted Docker Engine job that builds the image and runs unmodified Compose health checks. Its operator-only bootstrap streams a private password file into a one-off nonroot container with registration closed; login/admin access and closed registration are checked. It restarts the app and restores actual demo body/image data into a fresh project, then rechecks both those hashes and administrator login, followed by the failure-guard drill. The API suite owns real-HTTP trusted-proxy/two-client/forged-header regression coverage; the Compose smoke does not itself configure a reverse proxy. Adding a workflow is not evidence that GitHub has executed it. Every release must record the actual revision, command, environment, failures and skipped tests.

## Evidence and publication policy

Release summaries should identify the tested revision, commands and results using synthetic fixtures and public CI status. A test definition, successful compilation or screenshot does not establish unrelated behavior. Database tests must actually use an isolated database, and browser tests must exercise the matching compiled application.

Do not publish raw browser traces, session files, environment files, credentials, private articles, machine paths or diagnostic bundles. Keep failure investigation local to authorized test resources. The public-content checker reports only file locations and rule names; it supplements review and does not prove the absence of every possible secret.

Before release, verify authentication and account isolation, desktop/mobile/tablet controls, e-ink behavior, PWA install/update and offline replay, archive retention after an upstream outage, database/file recovery, SMTP behavior against a fixture, and migration/rollback instructions. Record platform or source restrictions precisely; do not imply that controlled fixtures prove every external service is reachable.
