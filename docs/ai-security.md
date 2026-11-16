# Optional AI: security, operation and integration

This is an implementation and verification guide, **not hosted acceptance evidence or a performance claim**. The new AI tests have to run on approved GitHub-hosted infrastructure with synthetic data. No real provider credentials, paid calls, private articles, production dumps or reference captures are needed.

## Parent integration (outside this seam)

1. Add exact API dependencies `franc@6.2.0` (language detection) and `domhandler@5.0.3` (explicit DOM node type dependency). Preserve their upstream license notices. No dependency manifests or lockfiles were changed in this lane. All other imports already exist in the API dependencies or Node standard library.
2. Build shared types before API/web. `packages/shared/src/index.ts` exports `AiConfig`, `AiJob`, `AiOperation` and `AiLanguage` through `./ai.js`.
3. In `apps/api/src/app.ts`, import:
   ```ts
   import { AiService } from './ai.js';
   import { aiEnvironmentFromEnv } from './ai-security.js';
   import { installAiRoutes } from './ai-routes.js';
   ```
   After migration and **after `new Auth(...).install(...)`**, construct/register:
   ```ts
   const ai = new AiService(db, aiEnvironmentFromEnv());
   installAiRoutes(app, ai, { worker: config.worker });
   ```
   The optional third `AiService` argument is a synthetic provider seam for tests, not an alternate production transport. Do not accept it from HTTP input. `installAiRoutes` registers an `onReady` worker hook only when enabled, and a `preClose` hook that aborts/drains AI work **before** the existing application `onClose` closes PostgreSQL. For a separate worker process call `start()` and await `stop()` before `db.end()`. Do not register multiple AI services on the same Fastify instance.
4. Migration discovery already loads sorted `.sql` files. Apply additive `009_ai.sql` after existing migrations (and parent-owned 007/008 where present). It uses the existing `(articles.id, articles.user_id)` ownership constraint. No old migrations are edited. AI tables cascade with article/user deletion; no original content, annotations, retained contexts or blobs are updated by AI.
5. Keep the existing method-only request serializer, header redaction and sanitized global error handler. Do not enable request-body, SQL-parameter, raw provider response, or full request/TLS-error logging. The AI plugin adds its own safe error mapping and fatal UTF-8 JSON parser. Register after Auth so session, Origin and CSRF hooks are inherited, not replaced; its own missing-auth guard is additional defense, not a substitute for Auth.
6. Existing API `test/*.test.ts` glob and repository test typecheck include the new source-named tests; no new package script is required. Hosted CI must install the dependencies, build shared, typecheck API/tests, and run the API tests. The network/PG suites require `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`; PG additionally needs a fresh synthetic `TEST_DATABASE_URL`. Never set these flags to bypass the infrastructure restriction locally. No PostgreSQL service or fake-provider socket was run in this implementation lane.

Suggested **hosted-only** gates after parent integration:

```sh
npm run build -w @feedink/ink
npm run build -w @feedink/shared
npm run typecheck -w @feedink/api
npx tsc -p tsconfig.tests.json
npm exec -w @feedink/api -- tsx --test --test-concurrency=1 test/ai-security.test.ts test/ai-content.test.ts test/ai-postgres.test.ts
npm run test -w @feedink/api
```

The parent owns installation, script/workflow changes, all execution gates, integration and publication. API/web integration and browser toolbar tests are not established by these source files alone.

## Private operator configuration

- `AI_ENCRYPTION_KEY`: canonical base64 encoding of **32 independently generated random bytes**. Missing or invalid values disable secret persistence/use, without failing RSS startup. There is no fallback to the session key, plaintext or an ephemeral key. Preserve this stable key with private deployment configuration and recovery material; never put it in this repository, CI output, public archives or the browser.
- `AI_ALLOW_HOSTS`: comma-separated exact lowercase hostnames or unbracketed IP literals, **not** URLs, wildcard suffixes, ports or user-controlled request fields. An invalid list disables all exceptions. This separate list does not inherit `FETCH_ALLOW_HOSTS`. Explicit exceptions can permit HTTP/private/loopback self-managed or CI providers. Without an exception the destination must be public HTTPS on port 443. Grant exceptions narrowly: allowing a hostname explicitly trusts that hostname's resolved addresses.

API credentials use AES-256-GCM, independent random 96-bit nonces, 128-bit tags and associated data `["feedink-ai-key",1,owner,configRevision]`. Changing metadata re-encrypts a retained credential under the new revision. Owner substitution, revision substitution, tampering, deployment-key loss or a changed encryption key fails closed. Omitted `apiKey` retains the authenticated old key; `null` clears it, including when the deployment key is unavailable. Replacing a credential does not require decrypting the old credential. Losing the stable deployment key requires explicitly saving new provider credentials; rotating the session secret does not.

`GET/PUT /api/ai/config` return **direct metadata**, never a key, envelope, nonce or credential hint. Defaults are `{enabled:false,baseUrl:"",model:"",hasKey:false,targetLanguage:"zh-CN",revision:0,updatedAt:null}`. One configuration row exists per account. Disabled metadata can be saved without a key; enabling requires URL, model and an authenticated stored key. All updates advance the revision. Demo accounts cannot configure AI or invoke connectivity/article work.

`POST /api/ai/config/test` uses the saved configuration (it may be disabled), makes one explicit JSON connectivity request and returns `{ok:true}`. It accepts no provider override and no article content. There is one process-local pending probe and one PostgreSQL advisory-locked probe globally. It never retries. It is not a public proxy.

## Transport and redaction

The production `PinnedAiProvider` is the only default transport. For each request it resolves the URL hostname, validates **all** returned addresses, then pins the socket lookup to an already validated address while retaining the URL Host/SNI and normal TLS certificate verification. No agent pooling, proxy environment transport, second DNS lookup, automatic SDK retries or alternate transport is used. Even same-origin redirects are refused; no redirect receives the authorization header or article body. DNS and HTTP share a 45-second deadline. Responses must be uncompressed JSON, HTTP 200, at most 512 KiB, exactly one completion, `finish_reason:"stop"`, no tool calls/refusal. Requests are at most 128 KiB with `max_tokens:8192` for article work and `max_tokens:16` for the connectivity probe. Unsupported JSON-mode providers fail safely rather than silently switching protocol.

Exceptions and job error DTOs use a fixed vocabulary. Provider bodies, Node/TLS/parser exception strings and SQL parameter details are never used as error messages or written to logs. Successful model content is parsed as schema-validated text, not returned as a raw completion envelope. A completion reflecting the saved API key is rejected. Do not attach full provider objects to telemetry; record only safe counts/status/codes if operational telemetry is added elsewhere.

## Source identity and browser contract

`POST /api/articles/:id/ai` accepts only `operation`, selected `mode`, optional `targetLanguage`, `force`, and optional **expected** `contentHash`. The last field is a precondition: it must match the current authoritative selected owned source or the request fails HTTP 409 before enqueueing or invoking a provider. It cannot replace source data.

`AiJob.contentHash` uses the existing `Annotations.currentContext` / `canonicalAnnotationHash` semantics, **not** the ingest `ArticleDetail.contentHash`. The cache additionally fingerprints title and exact selected stored HTML, so title/image-ID presentation changes do not reuse an old title-dependent result even if the portable canonical hash is unchanged. Keys include owner/article/mode/source fingerprint/operation/target/config revision/prompt version. Missing fulltext fails explicitly; it never falls back to feed content. The browser must keep its selected raw feed/fulltext view and original annotations separate, verify expected canonical context on explicit action, and fence polling/publication by account/auth epoch, article, mode and current source metadata. `result.sourceTitle/sourceUrl` describe the captured source, not model-generated metadata.

Bilingual output uses server-owned markers only:

```html
<section class="feedink-ai-pair">
  <div class="feedink-ai-source"><p>Original paragraph</p></div>
  <div class="feedink-ai-target" lang="zh-CN"><p>Translated paragraph</p></div>
</section>
```

Pairs are paragraph/inline-run level, not two whole-article blocks. Title, headings, lists, table-cell prose and captions are included. Original classes/IDs are stripped before adding markers; only the exact marker classes survive final sanitization. Link destinations and authenticated owned image references come exclusively from the trusted sanitized source. Text translations replace text/alt/title only and cannot create links, images, HTML or executable Markdown. The translated view carries no original ink/annotation positional anchors. Code/preformatted code is left unchanged by translation because programmatic tokens and formatting must not be localized; summary includes the code as source input. Render summary as plain text above the original selected body, never as HTML/Markdown.

## Durable queue, budgets and recovery

- Jobs are stored in PostgreSQL with queued/running/succeeded/skipped/failed/cancelled states; POST returns 202, or 200 for a current complete cache hit. GET and DELETE are owner-scoped, with DELETE returning 202. Repeated active clicks reuse one ID. Force against an already active identical key returns `AI_ACTIVE_JOB`; it never overwrites an in-flight row. Failed/cancelled retained jobs require explicit `force:true` for another attempt, rather than a blind paid retry.
- A short PostgreSQL advisory transaction serializes admissions/claims. Maximum 128 queued/running jobs globally, 8 per owner; maximum 2 running claims globally and one per owner. Each process has at most 2 local worker tasks. Cancellation/config invalidation abort local sockets promptly or are observed by another process on its next heartbeat. **A provider may continue billing/computing a POST already accepted even after client cancellation.** During cancellation/lease loss a remote in-flight call can temporarily outlive its terminal DB status; the claim cap is not a provider-side exactly-once/billing guarantee. Bound the number of deployed worker replicas as well.
- Claims have a random fencing token and 120-second lease, checked before calls/checkpoints/publication. Heartbeats run every 2 seconds and do not resurrect expired leases. Each job has a 30-minute processing deadline. Call intent is committed before each POST; work is never requeued after an expired running lease, even if the provider outcome or database commit was ambiguous. The error is `AI_INTERRUPTED`; retry is an explicit user choice. A lost terminal commit cannot cause an automatic paid replay.
- Source/config freshness is checked under user/article locks before each call and final publication; changed config proactively invalidates active work. Cancelled/failed/stale workers cannot publish with an old lease token. GET hides invalidated results, including title/source changes after successful completion. Article and annotation storage is read-only throughout this process.
- Input bounds: 2 Mi UTF-16 code units of selected HTML, 65,536 title units, 50,000 parsed nodes, nesting depth 100, 4,096 eligible segments. Individual text nodes are split losslessly at Unicode code-point boundaries into at most 1,200 UTF-16 units per segment. Every segment is included, including content after 14k; nothing silently takes a prefix. Batches contain at most 6,000 text units/32 segments. At most 512 provider calls/job; output at most 4 Mi translated text units / 8 Mi rendered HTML units. Exceeding a budget fails, never caches partial success.
- Translation requires every expected ID exactly once, no extras, nonempty bounded text, valid Unicode and a non-truncated completion. Progress is committed only after validating a complete batch. Missing/duplicate IDs, `finish_reason:length`, invalid JSON, refusal and partial responses fail closed.
- Summary sends every selected title/prose/caption/code segment through bounded leaf summaries, then reduces **all** leaf summaries until one remains (at most 8 reduction levels). Each response must list exactly all input IDs; reduction stages add to `totalChunks`, so the denominator can increase. `completedChunks/totalChunks` describe validated coverage, not token usage or semantic model-quality proof.
- `franc` detects every eligible sentence/window, not only a prefix. Short/ambiguous windows and incompatible scripts veto same-target skipping; only confident all-window consensus skips. Mixed/unknown content is processed. This intentionally produces false negatives (unnecessary translation) rather than confidently claiming short/uncertain input is already complete. Statistical detection cannot guarantee every borrowed word or same-script code-switch is identified; no universal language/model-quality claim is made.
- Terminal rows expire after 7 days in batches of 128. Admission also bounds retained owner history and global rows (roughly 128 terminal rows/owner and at most 4,096 global rows), evicting oldest terminal rows, never active jobs or original sources. These are cache/job records, not annotation archives. A retained worst-case result can be large; plan database/TOAST capacity for up to tens of GiB at the configured global bound, not just queue-row count. Encryption credentials and AI results are not added to old portable archive formats.

Short AI database transactions set a 5-second lock timeout and 15-second statement timeout. Configure a database-wide statement timeout for standalone heartbeat/cleanup statements as well; the shared pool is parent-owned. Configure an HTTP proxy timeout of at least 60 seconds for the explicit connectivity probe; article POST/GET/DELETE do not hold the browser request for job completion. Graceful termination must allow an HTTP call deadline plus database drain, and stop AI before closing the shared pool. A hard kill leaves lease-fenced interrupted work for the next worker, never an automatic retry.

## Authored acceptance coverage and remaining limits

- `ai-security.test.ts`: AES-GCM at rest, nonce uniqueness, owner/version substitution/tamper/wrong-key refusal, optional env, safe errors, exact host policy, mixed DNS answers, fresh pinned resolution, redirect denial without recipient leakage, truncation, provider error masking, dropped outcomes and abort.
- `ai-content.test.ts`: whole long-node/title/caption/alt coverage, Unicode splitting, code policy, paragraph pairing, text-only hostile model payloads, trusted links/owned assets, missing/duplicate/invented IDs, incomplete summaries, source budgets and conservative same/mixed/unknown language handling.
- `ai-postgres.test.ts`: defaults/direct metadata, key omission/clear, auth/Origin/CSRF/demo, substitution, owner source/job denial, canonical precondition, fulltext refusal, durable concurrent dedupe/force, long translation, hierarchical late-content summary, source/annotation immutability, cache/title/config/mode invalidation, progress/cancellation, provider loss, expired lease fencing, owner admission/global claims, retention and worker drain.

All these tests are **authored, not executed in this lane**. Real provider translation quality, statistical language thresholds across the supported languages, replica cancellation races, resource ceilings, complex HTML accessibility, SQL plans and browser rendering still require hosted review/measurement. No million-article throughput, latency or capacity result follows from source inspection. No paid/demo provider calls were made.
