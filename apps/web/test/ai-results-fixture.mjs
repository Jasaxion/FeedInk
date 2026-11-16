// Synthetic owned terminal-metadata contract fixture. No provider or PostgreSQL acceptance claims.
import assert from 'node:assert/strict';
import { aiFixture } from './ai-fixture.mjs';

export async function aiResultsFixture() {
  const fixture = await aiFixture();
  const results = { rows: new Map(), calls: [], deleted: [], holdList: null, holdDeleteReply: null, failList: false, rejectDelete: false, loseDeleteReply: false };
  const terminal = status => ['succeeded', 'skipped', 'failed', 'cancelled'].includes(status);
  for (let index = 1; index <= 23; index++) {
    const id = `retained-${String(index).padStart(2, '0')}`;
    results.rows.set(id, { id, owner: 'alice', articleId: 'one', sourceTitle: `Retained source ${index}`, mode: index % 2 ? 'feed' : 'fulltext', contentHash: 'a'.repeat(64), operation: index % 2 ? 'summary' : 'translate', targetLanguage: index % 2 ? 'zh-CN' : 'ja', status: ['succeeded', 'skipped', 'failed', 'cancelled'][index % 4], model: 'retained-synthetic-model', createdAt: `2010-01-01T00:00:00.${String(index).padStart(6, '0')}Z`, updatedAt: '2010-01-02T00:00:00.000001Z' });
  }
  const first = results.rows.get('retained-01');
  results.rows.set('foreign-result', { ...first, id: 'foreign-result', owner: 'bob', sourceTitle: 'Bob-only retained source' });
  results.rows.set('active-result', { ...first, id: 'active-result', status: 'running', sourceTitle: 'Running task never offered for cleanup' });
  const all = () => new Map([...results.rows, ...[...fixture.ai.jobs].map(([id, job]) => [id, { ...job, model: job.model || 'synthetic-model', sourceTitle: job.result?.sourceTitle || fixture.control.articles.find(article => article.id === job.articleId)?.title || '' }])]);
  const metadata = row => {
    const { id, articleId, sourceTitle, mode, contentHash, operation, targetLanguage, status, model, createdAt, updatedAt } = row;
    return { id, articleId, sourceTitle, mode, contentHash, operation, targetLanguage, status, model, createdAt, updatedAt };
  };
  fixture.route('/api/ai/results', async ({ request, url, body, json }) => {
    const owner = fixture.control.user.id;
    if (request.method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      results.calls.push({ method: 'GET', owner, cursor, limit: url.searchParams.get('limit') });
      assert.equal(url.searchParams.get('limit'), '20');
      if (results.failList) return json({ error: { code: 'SYNTHETIC_LIST_FAILED', message: 'fixture unavailable' } }, 503);
      const owned = [...all().values()].filter(row => row.owner === owner && terminal(row.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      let remaining = owned;
      if (cursor) {
        const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        // Compare original microsecond strings, never JS Dates or offset pagination.
        remaining = owned.filter(row => row.createdAt < createdAt || row.createdAt === createdAt && row.id < id);
      }
      const page = remaining.slice(0, 20), last = page.at(-1);
      const captured = { items: page.map(metadata), total: owned.length, nextCursor: remaining.length > page.length ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64') : null };
      const hold = results.holdList; results.holdList = null; if (hold) await hold.promise;
      return json(captured);
    }
    assert.equal(request.method, 'DELETE');
    const data = await body(); results.calls.push({ method: 'DELETE', owner, ids: data.ids });
    const rows = all(), ids = data.ids;
    const accepted = Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 && new Set(ids).size === ids.length && ids.every(id => rows.get(id)?.owner === owner && terminal(rows.get(id)?.status));
    if (!accepted || results.rejectDelete) return json({ error: { code: 'AI_RESULT_SELECTION', message: 'selection rejected' } }, 409);
    for (const id of ids) { results.rows.delete(id); fixture.ai.jobs.delete(id); }
    results.deleted.push([...ids]);
    const hold = results.holdDeleteReply; results.holdDeleteReply = null; if (hold) await hold.promise;
    if (results.loseDeleteReply) { results.loseDeleteReply = false; request.socket.destroy(); return; }
    return json({ deleted: ids.length });
  });
  return { ...fixture, results };
}
