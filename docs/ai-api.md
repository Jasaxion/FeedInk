# Optional AI reading contract

Development contract; not a claim that unreleased endpoints have passed validation.

AI is explicit and account-scoped. It never processes the corpus automatically. The original article, source URL, canonical context and annotations remain unchanged. Summary is presented above the original body; translation is a separately rendered bilingual view. Raw original text remains available for annotation. This does not add mutating MCP tools.

## Configuration

`GET /api/ai/config` returns metadata only:

```text
{ enabled, baseUrl, model, hasKey, targetLanguage, revision, updatedAt }
```

`PUT /api/ai/config` accepts `{enabled,baseUrl,model,targetLanguage,apiKey?}`. Omitted `apiKey` retains the stored key; `null` clears it. An API key is never returned after saving. One active OpenAI-compatible configuration per account is sufficient for the initial implementation. Default target is `zh-CN`; allow `en`, `ja`, `ko`, `fr`, `de`, and `es`. POST `/api/ai/config/test` explicitly performs a minimal provider request using the saved configuration, returning only safe connectivity metadata.

Store secrets using authenticated encryption, a separate stable 32-byte base64 `AI_ENCRYPTION_KEY`, unique nonces and owner/config-version-bound associated data. Missing encryption configuration must disable secret persistence, not fall back to plaintext or a transient key. Keep this deployment key with the private configuration during migration; session-key rotation must not invalidate saved AI credentials.

Default provider destinations must be HTTPS and pass DNS/address/redirect validation. Operator-only `AI_ALLOW_HOSTS` can authorize exact private/loopback test or self-managed hosts; user configuration cannot grant network exceptions. No cross-origin redirect may forward a credential. No browser-held key, public proxy, raw provider error/body logging, or retry through an alternate untrusted transport. Demo accounts cannot configure secrets or invoke paid AI work.

## Explicit article jobs

`POST /api/articles/:id/ai` accepts `{operation:"summary"|"translate",mode:"feed"|"fulltext",targetLanguage?,force?}`. It binds to an authoritative owned content snapshot and returns HTTP202 `{job: AiJob}`. A cached completed matching result may return HTTP200. Repeated clicks for the same active job must not duplicate provider requests.

`GET /api/ai/jobs/:id` returns `{job: AiJob}`; `DELETE /api/ai/jobs/:id` requests cancellation and returns HTTP202/204. All routes use existing session, owner, Origin and CSRF rules. No arbitrary article/body replacement is accepted from the browser.

```text
AiJob = {
  id, articleId, mode, contentHash, operation, targetLanguage,
  status: "queued"|"running"|"succeeded"|"skipped"|"failed"|"cancelled",
  stage, completedChunks, totalChunks, detectedLanguage,
  createdAt, updatedAt,
  result?: { summaryText?, bilingualHtml?, sourceTitle, sourceUrl },
  error?: { code, message }
}
```

Results and active jobs are keyed by owner/article/mode/source hash/operation/target/configuration revision/prompt version. `force` explicitly requests regeneration; it does not overwrite a different in-flight result. Older or cancelled results cannot replace a new article/context in the UI. Navigation may stop UI polling while an explicitly requested job finishes privately; cancellation is a distinct user action.

Use a durable PostgreSQL job queue, bounded worker concurrency/leases and request/output budgets rather than one unbounded HTTP request. A crash/ambiguous provider outcome must be reported as interrupted work requiring explicit retry, not silently billed again. Queue/lease queries need selective indexes and must not scan articles. Document process and proxy timeouts.

## Completeness and rendering

Detect language before translation. Skip only confidently matching target-language content; unknown or mixed-language input must not be silently classified as complete target text. Translate all eligible visible prose/title/captions in bounded segments, including long individual text nodes; preserve code and document why it is excluded. Report coverage and missing segments. A length-limited or missing-segment result must not be marked complete or cached as success.

For bilingual output retain original structure and trusted owned image references. Treat model output as text, never trust generated HTML/Markdown URLs. Build translated fragments from validated segment IDs and sanitize the final presentation. Do not attach original text/ink anchors to translated content as if their positions matched.

Summary must account for the complete selected source, using bounded hierarchical summarization when necessary, rather than silently cutting the input prefix. Summary and translation use the selected stored feed/fulltext mode; missing fulltext is an explicit error, not a claim to have processed an uncaptured full article.

## Acceptance

Tests use a local synthetic provider on hosted CI, never real user credentials or provider billing. Cover encrypted-at-rest storage, owner substitution/tamper refusal, masked readback/log redaction, destination safety, same-language skip, long/mixed-language coverage, truncation and missing IDs, progress/cancellation, caching/config/source invalidation, lost provider outcomes, original body/annotation immutability, and responsive toolbar/bilingual UI. Record measured scope and limitations rather than claiming universal model quality.
