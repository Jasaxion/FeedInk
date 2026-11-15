# Security and operator responsibilities

FeedInk is a multi-user RSS reader, not a public fetch proxy. Its threat model includes hostile feeds, redirects/DNS responses, HTML, image bytes, uploaded archives, other accounts and offline browser caches. The requirements in [api.md](api.md) define intended controls; passing targeted tests is evidence for those cases, **not a security audit or proof of complete isolation**.

## Deployment boundaries

- Use HTTPS, a correct `APP_URL`, same-origin API access and secure HttpOnly cookies. Do not bypass Origin/CSRF checks to make a proxy misconfiguration appear to work.
- Generate independent strong database/session secrets. Keep env files mode0600, off Git and out of build contexts. Limit access to the Docker daemon: container configuration contains secrets even when logs do not.
- Registration defaults closed in Compose. Administrator creation is operator-only via `bootstrap-admin` with a private password file/stdin, not public email matching; public registration never elevates an account. Bootstrap refuses an existing email or active administrator atomically. Keep registration closed unless deliberately accepting ordinary new users.
- `TRUST_PROXY` defaults to no trust. Configure only actual proxy peer IPs or dedicated proxy CIDRs, never universal ranges/hop counts or a client-supplied forwarded address. Strip untrusted forwarding headers at the edge and restrict direct access to the backend; validate independent real-client budgets through your actual proxy and spoof resistance from untrusted peers.
- PostgreSQL stays on the container network, without host publication. The app is nonroot, drops capabilities and has a read-only root filesystem; only `/data` and temporary scratch are writable.
- The app and database volumes plus backups contain private data. Use host/storage encryption, private off-host backup storage, access controls and a tested recovery procedure. Avoid blanket browser/proxy caching of authenticated endpoints.
- SMTP credentials should be restricted to the sender and rate-limited. Test with a mail sink, not third-party recipients. Demo access must not become an email relay. Unknown SMTP outcomes require provider-log investigation and the operator `reconcile-ebook` CLI; do not blindly retry uncertain deliveries or edit database flags to bypass deduplication.

## Fetching untrusted content

All feed, discovery, HTML and image fetches must validate schemes, destination addresses, redirects and DNS-to-connection binding. Local/private/link-local/metadata addresses are not safe just because the URL is submitted by a logged-in user. `FETCH_ALLOW_HOSTS` is an **operator-only exact-host test/private-feed exception**, empty by default and deliberately absent from production Compose. Do not enable it for public deployments or accept it from users. A test run with `127.0.0.1` allowed does not validate production SSRF behavior; include tests with the default empty allowlist.

Sanitize stored/imported HTML and client rendering. Archive images must be validated passive formats, fetched within size/time limits and served only through owned opaque asset IDs. Remote login walls, CAPTCHA, anti-bot rules and paywalls are not bypassed. A failed image capture must remain visibly failed; a live upstream URL is not evidence of durable archived bytes.

## Offline and shared-device use

PWA caches and pending mutations are private per-account data. Logout/account switching must clear the prior active identity, ordinary article/image cache and reading-state queue. Unsynchronized annotation drafts are different: lock/quarantine them without silently deleting them, block another owner while recovery remains unresolved, and require verified same-owner recovery or explicit authorized discard. If persistence cannot be confirmed, keep the current tab open and export/recover before clearing site data. Do not use offline mode on an untrusted shared device; physical access to browser storage is outside server-session protection. Browser storage may be evicted, so offline caching is never disaster recovery.

## Read-only AI access

MCP uses HTTPS except direct trusted loopback development. Proxy deployments must preserve and validate the configured authority and Origin. Never put MCP credentials in a URL; missing/invalid credentials are rejected rather than recovered from query parameters. Tokens are high-entropy secrets shown once, stored as hashes, and checked for expiry, revocation and disabled owners on each request. Grant the minimum article/note scopes and revoke unused tokens. Demo accounts cannot issue tokens.

Only owned data is returned. Source text, remarks and images are untrusted content, not tool instructions; clients must not expand permissions based on embedded prompts. Read-only note access can expose quotes, titles and source URLs. An AI client/model provider may retain content you choose to send; token scoping is not a promise about that provider’s storage policy.

## Reporting and response

Do not post live session cookies, authorization headers, real article bodies, SMTP credentials or database dumps in issues. Report a minimal first-party fixture and affected revision. For suspected disclosure, restrict access, preserve private evidence, rotate affected credentials, revoke active sessions explicitly and review ownership/cache boundaries before reopening. No coordinated disclosure mailbox or third-party audit is claimed by this repository.

Before a public release, review cross-user article/asset/archive access, CSRF/Origin behavior, password/session handling, SSRF redirects and IP forms, image/ZIP path/size/type validation, custom CSS isolation, private cache clearing and mail permissions. [testing.md](testing.md) records what is automated and where evidence still depends on real deployment drills.
