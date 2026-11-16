// Synthetic client contract fixture, not evidence of backend/provider correctness.
import assert from 'node:assert/strict';
import { auditFixture, emptyAnnotationDocument } from './audit-fixture.mjs';

export async function aiFixture() {
  const fixture = await auditFixture();
  const state = {
    config: { enabled: true, baseUrl: 'https://provider.example.test/v1', model: 'synthetic-model', hasKey: true, targetLanguage: 'zh-CN', revision: 1, updatedAt: '2026-01-01T00:00:00Z' },
    calls: [], jobs: new Map(), providerCalls: 0, autoComplete: false, saveFails: false, pollFails: false, cancelFails: false,
    holdConfig: null, holdPost: null, holdPoll: null, holdContext: null, responsePatch: null, annotationWrites: [], losePostReply: false, rejectedAdmissions: 0,
  };
  const article = fixture.control.articles[0];
  article.contentHash = 'c'.repeat(64); // Deliberately NOT the canonical annotation hash.
  article.contentHtml = '<p>Original first paragraph <a href="https://example.test/source-link">source link</a></p><img src="/api/assets/image-one" alt="owned image">' + Array.from({ length: 130 }, (_, index) => `<p>Original segment ${index}: ${'synthetic prose '.repeat(30)}</p>`).join('') + '<p>Original long tail witness</p><details><summary>Disclosure source</summary><p>Disclosure original and translated body</p></details>';
  article.fulltextHtml = '<p>Fulltext original first</p><p>Fulltext original tail</p>';
  function complete(job) {
    const source = fixture.control.articles.find(article => article.id === job.articleId);
    return { ...job, status: 'succeeded', stage: 'complete', completedChunks: job.totalChunks, result: { sourceTitle: source.title, sourceUrl: source.url,
      ...(job.operation === 'summary' ? { summaryText: 'Synthetic summary including long tail <img src=x onerror=alert(1)>' } : { bilingualHtml: '<img src="https://injected.invalid/tracker"><img src="/api/assets/not-in-this-article"><img src="/api/assets/image-one" alt="owned image"><a href="https://injected.invalid/link">injected link</a><a href="https://example.test/source-link">source link</a><script>window.__aiInjected=true</script>' + Array.from({ length: 130 }, (_, index) => `<section class="feedink-ai-pair injected-class" style="position:fixed"><div class="feedink-ai-source" lang="en"><p>Original segment ${index}</p></div><div class="feedink-ai-target" lang="${job.targetLanguage}" data-annotation-context="forged"><p>译文段落 ${index} ${'长正文测试 '.repeat(30)}</p></div></section>`).join('') + '<section class="feedink-ai-pair"><div class="feedink-ai-source" lang="en"><p>Original long tail witness</p></div><div class="feedink-ai-target" lang="zh-CN"><p>译文末尾覆盖见证</p></div></section><details><summary><span class="feedink-ai-source" lang="en">Disclosure source</span><span class="feedink-ai-target" lang="zh-CN">展开译文详情</span></summary><p>Disclosure original and translated body 详情正文</p></details><pre><code>const unchanged = true;</code></pre>' }),
    } };
  }
  state.complete = id => { const job = state.jobs.get(id); state.jobs.set(id, complete(job)); };
  fixture.route('/api/ai/config', async ({ request, body, json }) => {
    state.calls.push({ kind: 'config', method: request.method, owner: fixture.control.user.id });
    if (request.method === 'PUT') {
      const data = await body(); state.calls.push({ kind: 'save', data });
      if (state.saveFails) return json({ error: { code: 'AI_CONFIG', message: 'fixture rejected configuration' } }, 422);
      const { apiKey, ...metadata } = data;
      state.config = { ...state.config, ...metadata, hasKey: apiKey === null ? false : apiKey ? true : state.config.hasKey, revision: state.config.revision + 1 };
    }
    const captured = { ...state.config }; const hold = state.holdConfig; state.holdConfig = null;
    if (hold) await hold.promise;
    return json(captured);
  });
  fixture.route('/api/ai/config/test', ({ json }) => { state.calls.push({ kind: 'test', model: state.config.model }); return json({ ok: true }); });
  const documents = new Map();
  fixture.route(/^\/api\/articles\/[^/]+\/annotations$/, async ({ request, url, body, json }) => {
    const id = url.pathname.split('/')[3], mode = url.searchParams.get('mode') || 'feed';
    const source = fixture.control.articles.find(article => article.id === id), key = `${id}:${mode}`;
    let document = documents.get(key) || emptyAnnotationDocument(source, mode);
    if (request.method === 'PUT') {
      const data = await body(); state.annotationWrites.push({ id, mode, data });
      assert.equal(request.headers['if-match'], `"${document.revision}"`);
      document = { ...document, ...data, id: key, revision: document.revision + 1, updatedAt: '2026-01-01T00:00:00Z' }; documents.set(key, document);
    }
    const captured = structuredClone(document); const hold = state.holdContext; state.holdContext = null;
    if (hold) await hold.promise;
    return json(captured);
  });
  fixture.route(/^\/api\/articles\/[^/]+\/ai$/, async ({ request, response, url, body, json }) => {
    assert.equal(request.method, 'POST');
    const data = await body(), articleId = url.pathname.split('/')[3], owner = fixture.control.user.id;
    state.calls.push({ kind: 'post', owner, articleId, data });
    assert.equal(data.contentHash, (data.mode === 'fulltext' ? 'b' : 'a').repeat(64));
    if (!Number.isSafeInteger(data.configRevision) || data.configRevision < 0) return json({ error: { code: 'VALIDATION', message: 'configRevision required' } }, 400);
    if (data.configRevision !== state.config.revision) {
      state.rejectedAdmissions++;
      return json({ error: { code: 'AI_CONFIG_CHANGED', message: 'Configuration changed; reopen the action' } }, 409);
    }
    const matches = [...state.jobs.values()].filter(job => job.owner === owner && job.articleId === articleId && job.mode === data.mode && job.contentHash === data.contentHash && job.operation === data.operation && job.targetLanguage === data.targetLanguage && job.configRevision === state.config.revision);
    const active = matches.find(job => ['queued', 'running'].includes(job.status));
    if (active && data.force) return json({ error: { code: 'AI_ACTIVE_JOB', message: 'Matching work is active' } }, 409);
    const previous = matches.at(-1);
    if (!active && previous && !data.force && ['failed', 'cancelled'].includes(previous.status)) return json({ error: { code: 'AI_INTERRUPTED', message: 'Work was interrupted or its outcome is unknown; retry explicitly if desired' } }, 409);
    let job = active || (!data.force && previous);
    if (!job) {
      state.providerCalls++;
      job = { id: `job-${state.providerCalls}`, owner, configRevision: state.config.revision, articleId, mode: data.mode, contentHash: data.contentHash, operation: data.operation, targetLanguage: data.targetLanguage, status: 'running', stage: 'segments', completedChunks: 1, totalChunks: 131, detectedLanguage: 'en', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      if (state.autoComplete) job = complete(job);
      state.jobs.set(job.id, job);
    }
    const captured = { ...job, ...state.responsePatch }; const hold = state.holdPost; state.holdPost = null;
    if (hold) await hold.promise;
    if (state.losePostReply) {
      state.losePostReply = false;
      // A partial response cannot be transparently retried as a stale keep-alive socket.
      response.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '512', 'Cache-Control': 'no-store' });
      response.write('{"job":'); response.flushHeaders();
      setImmediate(() => response.destroy()); return;
    }
    return json({ job: captured }, 202);
  });
  fixture.route(/^\/api\/ai\/jobs\/[^/]+$/, async ({ request, url, json }) => {
    const id = url.pathname.split('/').at(-1), job = state.jobs.get(id);
    state.calls.push({ kind: request.method === 'DELETE' ? 'cancel' : 'poll', id, owner: fixture.control.user.id });
    if (!job || job.owner !== fixture.control.user.id) return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    if (request.method === 'DELETE') {
      if (state.cancelFails) return json({ error: { code: 'AI_CANCEL', message: 'fixture cancel failure' } }, 503);
      state.jobs.set(id, { ...job, status: 'cancelled' }); return json({ accepted: true }, 202);
    }
    if (state.pollFails) return json({ error: { code: 'AI_POLL', message: 'fixture poll failure' } }, 503);
    const captured = structuredClone(job); const hold = state.holdPoll; state.holdPoll = null;
    if (hold) await hold.promise;
    return json({ job: captured });
  });
  return { ...fixture, ai: state };
}
