# Validation and release gates

Use an isolated test host/workspace with Node24.22.3, npm11, PostgreSQL17 and sufficient disk. Do not run these against production users, SMTP recipients or archives. Use isolated test infrastructure with adequate resources for dependency installation, builds and browsers. This project's hosted verification runs on GitHub Actions; SSH hostnames and private paths are operator configuration, not application requirements. When copying from macOS, use `COPYFILE_DISABLE=1 tar --no-xattrs` or exclude `._*` with rsync so AppleDouble files cannot become fake TypeScript tests.

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

For the browser and real-API suite, keep `TEST_DATABASE_URL` set to the dedicated test database:

```sh
npx playwright install --with-deps chromium webkit
for project in api desktop mobile tablet webkit workflows mcp; do
  node tests/run-project.mjs "$project"
done
# Install Poppler and CJK fonts on the test host for actual PDF inspection.
for project in annotations annotations-mobile annotations-webkit; do
  for shard in 1 2 3; do
    node tests/run-project.mjs "$project" "--shard=$shard/3"
  done
done
for browser in chromium webkit; do
  for suite in browser audit shell images offline-origin annotations; do
    FEEDINK_BROWSER="$browser" npm run "test:$suite" -w @feedink/web
  done
done
npm run test:residual -w @feedink/web
```

The runner starts a fresh owned loopback API process per project, uses a private temporary archive directory and test-only private-host permissions, then closes its own processes and removes its temporary data. It never implicitly reuses production `DATABASE_URL`. Build first: the runner executes the compiled server. Each project or annotation shard has a fresh rate-limit budget rather than weakened production limits. Annotation shards use one worker and test-level sharding, preserving every case across all three batches.

For WebKit, an owned loopback proxy is the browser origin. The test stops that origin’s actual listener and destroys its connections, verifies HTTP is unreachable, reloads cached shell/body/images, checks queued edits against the still-running upstream API, then restores the origin and verifies synchronization and logout isolation. This avoids WPE protocol/routing failures before service-worker handling without skipping any offline assertion. Chromium retains protocol-level offline coverage. Connectivity events are simulated test inputs; neither is a hardware airplane-mode certification. The proxy’s private control capability is temporary and never logged or published. Annotation tests also use exact HTTP-level held-PUT and 503 controls: a direct authenticated upstream witness writes the competing revision, and releasing the original browser request must produce a real 412. Service workers remain enabled; these are not browser-route mocks that WebKit can bypass.

Playwright starts `tests/fixtures/upstream.mjs`; do not start a duplicate. If a port is occupied, choose a free `FEEDINK_TEST_PORT` for the API, and set both `FEEDINK_FIXTURE_PORT` and `FEEDINK_FIXTURE_URL` for the upstream fixture. Never kill an unknown listener. WebKit’s proxy/control listeners use automatically allocated loopback ports. Screenshots and traces are private test output, not committed source or automatically uploaded artifacts.

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

The application test creates an isolated first-party demo account and records body/image hashes plus a text-note and raw pressure-stroke revision. `STATE_FILE` contains its live session cookie: keep it private and outside the checkout, and never upload it as evidence. It checks the SPA, manifest, service worker response, database health, article count, body/image byte hashes, original annotation data and unauthenticated asset denial. It does **not** install a PWA or exercise browser offline behavior.

The recovery drill uses a first-party SQL body and four binary bytes, **new uniquely named Compose projects**, no published PostgreSQL ports and separate data/database volumes. It checks running-app refusal, no overwrite, explicit restore confirmation, bundle symlinks including trailing-slash spellings, exact SQL/body-byte restoration and nonempty database/data refusal. Database fixtures include a function-only database, a collation-only database, a handler-free foreign-data wrapper, a cast between built-in types and an explicitly low-OID large object. Refusals check the expected diagnostic and verify no application table or file was restored. The checksum regression flips a payload byte **without changing framing**, independently validates the modified archive's framing, and uses a new empty target; it requires `Backup checksum mismatch` and verifies both stores remain empty. It stops its own projects and reports their names and private evidence directory; it does not delete evidence or volumes. Review and remove only those exact test resources afterward if desired, never prune shared host resources. The archive utility tests cover traversal, symlinks, conflicting paths, truncation, unknown versions/fields and size bounds.

The GitHub workflow runs unit/type/build/database tests with `TEST_DATABASE_URL` and a PostgreSQL service, isolated-per-project Chromium/WebKit acceptance, and a separate hosted Docker Engine job that builds the image and runs unmodified Compose health checks. Its operator-only bootstrap streams a private password file into a one-off nonroot container with registration closed; login/admin access and closed registration are checked. It restarts the app and restores actual demo body/image/annotation data into a fresh project, then rechecks hashes, raw notes, administrator login and the original MCP credential, followed by the failure-guard drill. The Compose job uses an isolated HTTPS proxy, an explicitly trusted test certificate and the exact owned network gateway as `TRUST_PROXY`; external Host and Origin rejection are checked through that proxy. Private credential files are never uploaded. The API suite additionally covers real SDK interoperability, trusted/forged forwarding and concurrent principals. Client regression and real API/browser gates both must succeed before any code-only runtime bundle is published. Bundles include repository and workspace licenses/notices, but no database, archive data, environment, dependency tree or raw diagnostics. Adding a workflow is not evidence that GitHub has executed it. Every release must record the actual revision, command, environment, failures and skipped tests.

## Evidence and publication policy

Release summaries should identify the tested revision, commands and results using synthetic fixtures and public CI status. A test definition, successful compilation or screenshot does not establish unrelated behavior. Database tests must actually use an isolated database, and browser tests must exercise the matching compiled application.

Do not publish raw browser traces, session files, environment files, credentials, private articles, machine paths or diagnostic bundles. Keep failure investigation local to authorized test resources. The public-content checker reports only file locations and rule names; it supplements review and does not prove the absence of every possible secret.

Before release, verify authentication and account isolation, desktop/mobile/tablet controls, e-ink behavior, PWA install/update and offline replay, archive retention after an upstream outage, database/file recovery, SMTP behavior against a fixture, and migration/rollback instructions. Record platform or source restrictions precisely; do not imply that controlled fixtures prove every external service is reachable.
