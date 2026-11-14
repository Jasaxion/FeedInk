# Validation and release gates

Use an isolated test host/workspace with Node24.22.3, npm11, PostgreSQL17 and sufficient disk. Do not run these against production users, SMTP recipients or archives. Repository policy delegates heavy dependency installation, production builds and browsers to a separate compute host; SSH hostnames and private paths are operator configuration, not application requirements. When copying from macOS, use `COPYFILE_DISABLE=1 tar --no-xattrs` or exclude `._*` with rsync so AppleDouble files cannot become fake TypeScript tests.

## Automated commands

```sh
npm ci
npm run build -w @feedink/shared
npm run typecheck
# Supply a dedicated disposable PostgreSQL URL; absent TEST_DATABASE_URL skips API integration.
export TEST_DATABASE_URL='postgresql://test_user:TEST_PASSWORD@127.0.0.1:5432/feedink_test'
npm test
node --test scripts/data-archive.test.mjs
for script in scripts/*.sh; do sh -n "$script"; done
npm run build
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

Run `api`, `desktop`, `mobile`, `tablet`, and optionally `webkit` separately, restarting only your own API process between projects. Combined browser projects share the same loopback rate-limit identity and can legitimately exhaust a minute's budget; do not disable or raise production limits to hide this. CI starts `node apps/api/dist/server.js` directly per project, uses bounded readiness, and terminates/waits for only its captured child PID. It installs both Chromium and WebKit and sets `FEEDINK_TEST_WEBKIT=1`.

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

## Evidence scope

Delivery implementation validation on 2026-11-14: Node24.22.3 archive-format tests **7/7 passed**, shell syntax passed, and PostgreSQL17.12 + independent-volume recovery/failure-guard drills passed using rootless Podman4.9.3 with Docker Compose2.32.4. The drill first passed with a utility-only image and was then repeated successfully with the **full preliminary production image**. The image compiled shared → web → API, ran as uid1000 on a read-only root filesystem, served the SPA/manifest/service worker, and returned database health. Twenty original demo articles plus stored body/image SHA-256 hashes survived an application restart and a paired database+volume restore into a fresh project. Unauthenticated image access returned401.

This was an explicitly **preliminary cross-workspace source snapshot**, not a final merged release build. Source hashes and the generated lock were retained as private implementation evidence; final source must be rebuilt and revalidated. Remote limitations were real: the initial registry pull timed out, Compose needed an isolated Podman API socket, `init:true` required an absent host helper (removed because the Node server handles termination signals directly), CNI service DNS was disabled, and automatic health probes failed while direct probes passed. A test-only override mapped `postgres` to the inspected IP of the owned database, and manual health execution verified both probes. **No DNS override or disabled health dependency is present in production Compose.** These checks prove the image/API/persistence under that compatibility workaround, not unmodified Docker Engine orchestration. Hosted Docker Engine CI has been defined but must actually execute against the final merged source before claiming that gate passed. No unrelated host resources were pruned.

Post-review backup regressions passed remotely on PostgreSQL17.12, including trailing-slash aliases, collation/FDW/cast detection and the framing-valid corruption/empty-target check. As a mutation test, removing only the checksum comparison in a private copy made the full drill fail specifically because corrupted-payload restore unexpectedly succeeded. This validates that the regression is not merely detecting malformed framing or a previously populated target.

The operator bootstrap/proxy API transition and revised CI must be validated against the consolidated lock and final source; an absent root `package-lock.json` is a real clean-build blocker, not a Podman limitation. Keep `npm ci` and the locked Docker build rather than substituting an unlocked install. Serving PWA files does not prove installation, offline behavior, account-switch isolation or browser parity. Do not interpret this evidence, the product contract or changelog as a completed feature checklist.

Before release, independently review HTTPS/cookies, desktop/mobile/tablet overflow and focus, e-ink/reduced-motion, PWA install/update, offline state replay and account-switch cache isolation, data/asset cross-user access, a source-outage archive read, a database+volume recovery with real app data, SMTP failure/success against a mail sink, and an upgrade rollback. Use authorized public-feed samples as additional evidence; a controlled image fixture does not prove every WeChat/CDN anti-bot case works.
