import { test, expect, type APIRequestContext } from '@playwright/test';
import type { CreatedMcpToken, McpScope, TextAnnotation } from '../../packages/shared/src/index.js';
import { baseURL, csrf, resetUpstream } from './helpers.js';
import {
  annotationFixture, createAnnotationUser, fixtureQuote, fixtureRemark, fixtureTitle,
  getAnnotation, pngDimensions, putAnnotation, seedAnnotationArticles,
} from '../fixtures/annotation-fixtures.js';

// Bearer calls use fetch, not Playwright's traced request transport. Credentials never enter artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async ({ request }) => { await resetUpstream(request); });
test.afterEach(async ({ request }) => { await resetUpstream(request); });

type RecordValue = Record<string, unknown>;
interface ToolDefinition { name: string; inputSchema: { type: string; properties: RecordValue }; annotations?: { readOnlyHint?: boolean } }
interface ToolResult { isError?: boolean; content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>; structuredContent?: RecordValue }
interface NotesResult {
  document: { id: string; articleId: string; mode: string; contentHash: string; title: string; sourceUrl: string; revision: number; updatedAt: string };
  marks: TextAnnotation[]; ink: { strokeCount: number }; totalMarks: number; nextOffset: number | null;
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP response must be a JSON object');
  return value as RecordValue;
}

/** Protocol HTTP witness, intentionally independent of the server SDK implementation. */
class McpWitness {
  private sequence = 0;
  private sessionId?: string;
  private protocolVersion?: string;
  constructor(private readonly token: string) {}

  private async exchange(method: string, params: unknown, notification = false): Promise<RecordValue> {
    const id = notification ? undefined : ++this.sequence;
    let response: Response;
    try {
      response = await fetch(new URL('/mcp', baseURL), {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${this.token}`, Origin: new URL(baseURL).origin,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      });
    } catch { throw new Error(`MCP ${method} transport failed; credential-bearing diagnostics withheld`); }
    expect(response.status, `MCP ${method} HTTP status`).toBe(notification ? 202 : 200);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (notification) { await response.body?.cancel(); return {}; }
    const parse = (text: string): RecordValue => {
      if (text.includes(this.token)) throw new Error('MCP response reflected a bearer credential; body withheld');
      try { return record(JSON.parse(text)); } catch { throw new Error('MCP returned invalid JSON; body withheld'); }
    };
    let envelope: RecordValue;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing MCP event stream');
      const decoder = new TextDecoder(); let pending = '', bytes = 0;
      let found: RecordValue | undefined;
      try {
        while (!found) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('MCP response exceeded acceptance witness byte budget');
          pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
          let end: number;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const event = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const value = parse(data);
            if (value.id === id) { found = value; break; }
          }
        }
      } finally { await reader.cancel(); }
      if (!found) throw new Error('MCP stream ended without matching JSON-RPC response');
      envelope = found;
    } else {
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      const text = await response.text();
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('MCP response exceeded acceptance witness byte budget');
      envelope = parse(text);
    }
    expect(envelope.jsonrpc).toBe('2.0'); expect(envelope.id).toBe(id);
    expect(Boolean(envelope.error), `MCP ${method} JSON-RPC error; details withheld`).toBe(false);
    return record(envelope.result);
  }

  async initialize() {
    const result = await this.exchange('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'feedink-independent-acceptance', version: '1.0.0' },
    });
    expect(typeof result.protocolVersion).toBe('string');
    expect(String(result.protocolVersion)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    this.protocolVersion = String(result.protocolVersion);
    expect(Boolean(record(result.capabilities).tools)).toBe(true);
    expect(typeof record(result.serverInfo).name).toBe('string');
    await this.exchange('notifications/initialized', {}, true);
  }

  async tools() { return (await this.exchange('tools/list', {})).tools as ToolDefinition[]; }
  async call(name: string, args: RecordValue) { return await this.exchange('tools/call', { name, arguments: args }) as unknown as ToolResult; }
}

function structured(result: ToolResult): RecordValue {
  expect(Boolean(result.isError), 'read-only MCP tool succeeded; error details withheld').toBe(false);
  const text = result.content.find(block => block.type === 'text')?.text;
  if (!text) throw new Error('MCP tools require a JSON text representation');
  let parsed: RecordValue;
  try { parsed = record(JSON.parse(text)); } catch { throw new Error('MCP tool text must be structured JSON; body withheld'); }
  expect(Boolean(result.structuredContent), 'MCP tool has structuredContent').toBe(true);
  expect(JSON.stringify(result.structuredContent) === JSON.stringify(parsed), 'structuredContent and JSON text carry the same result').toBe(true);
  return parsed;
}

async function createToken(api: APIRequestContext, session: Awaited<ReturnType<typeof createAnnotationUser>>, scopes: McpScope[]) {
  const response = await api.post('/api/mcp-tokens', { headers: csrf(session), data: { name: '独立验收临时令牌', scopes, expiresInDays: 1 } });
  expect(response.status(), 'token creation HTTP status; response withheld').toBe(201);
  const created: CreatedMcpToken = await response.json();
  expect(typeof created.token === 'string' && /^fi_mcp_[A-Za-z0-9_-]{40,}$/.test(created.token), 'generated bearer has required prefix and entropy-sized payload').toBe(true);
  expect(Boolean(created.access?.id), 'created token metadata has an id').toBe(true);
  expect(created.access.scopes).toEqual(scopes);
  const expires = Date.parse(created.access.expiresAt);
  expect(Number.isFinite(expires) && expires > Date.now() && expires <= Date.now() + 86_460_000, 'one-day expiry is bounded and in the future').toBe(true);
  return created;
}

async function deniedHttp(token?: string, origin = new URL(baseURL).origin, query = '') {
  try {
    const response = await fetch(new URL(`/mcp${query}`, baseURL), {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'boundary-witness', version: '1.0' } } }),
    });
    await response.body?.cancel();
    return response.status;
  } catch { throw new Error('MCP boundary request failed; credential-bearing diagnostics withheld'); }
}

async function assertDeniedTool(client: McpWitness, name: string, args: RecordValue, forbiddenText: string, code: 'FORBIDDEN' | 'NOT_FOUND' = 'FORBIDDEN') {
  const result = await client.call(name, args);
  expect(result.isError, 'unauthorized tool call is an explicit tool error').toBe(true);
  expect(record(result.structuredContent).error && record(record(result.structuredContent).error).code).toBe(code);
  const text = result.content.find(block => block.type === 'text')?.text;
  expect(Boolean(text), 'denial has a JSON text representation').toBe(true);
  let errorText: unknown;
  try { errorText = JSON.parse(text!); } catch { throw new Error('Denial text must be JSON; body withheld'); }
  expect(JSON.stringify(errorText) === JSON.stringify(result.structuredContent), 'denial JSON and structuredContent agree').toBe(true);
  const body = JSON.stringify(result);
  expect(body.includes(forbiddenText), 'denied result must not disclose other scope/tenant content').toBe(false);
  expect(result.content.some(block => block.type === 'image'), 'denied result includes no image').toBe(false);
}

test('real initialize/list/call searches owned articles/notes and returns bounded PNGs with revision metadata', async ({ request }) => {
  const session = await createAnnotationUser(request);
  const { first } = await seedAnnotationArticles(request, session);
  const empty = await getAnnotation(request, first.id);
  const saved = await putAnnotation(request, session, empty, annotationFixture(empty.context));
  const credential = await createToken(request, session, ['articles:read', 'notes:read']);
  const client = new McpWitness(credential.token);
  await client.initialize();
  const tools = await client.tools();
  const expected = ['search_articles', 'get_article', 'get_article_image', 'list_notes', 'search_notes', 'get_notes', 'get_note_preview'];
  expect(tools.map(tool => tool.name).sort()).toEqual(expected.sort());
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.annotations?.readOnlyHint, `${tool.name} advertises read-only semantics`).toBe(true);
  }
  for (const name of ['search_articles', 'search_notes']) expect(Object.keys(tools.find(tool => tool.name === name)!.inputSchema.properties)).toEqual(expect.arrayContaining(['query', 'offset', 'limit']));
  const search = structured(await client.call('search_articles', { query: '持久存档', offset: 0, limit: 1 }));
  expect((search.items as { articleId: string }[]).map(item => item.articleId)).toEqual([first.id]);
  expect(search.total).toBe(1); expect(search.nextOffset).toBeNull();
  const article = structured(await client.call('get_article', { articleId: first.id, offset: 0, limit: 1200 }));
  expect(JSON.stringify(article)).toContain(fixtureQuote);
  expect(JSON.stringify(article)).toContain(fixtureTitle);
  const found = structured(await client.call('search_notes', { query: '验收备注', offset: 0, limit: 1 }));
  expect((found.items as { articleId: string }[]).map(item => item.articleId)).toEqual([first.id]);
  expect(found.total).toBe(1); expect(found.nextOffset).toBeNull();
  const listed = structured(await client.call('list_notes', { articleId: first.id, offset: 0, limit: 1 }));
  expect((listed.items as { articleId: string }[]).map(item => item.articleId)).toEqual([first.id]);
  const marks: TextAnnotation[] = [];
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < 10; page++) {
    const notes = structured(await client.call('get_notes', { articleId: first.id, mode: 'feed', contentHash: saved.contentHash, offset, limit: 2 })) as unknown as NotesResult;
    expect(notes.document).toMatchObject({ articleId: first.id, mode: 'feed', revision: saved.revision, contentHash: saved.contentHash, sourceUrl: first.url });
    expect(notes.ink.strokeCount).toBe(saved.ink!.strokes.length);
    expect(notes.totalMarks).toBe(saved.marks.length); expect(notes.marks.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(notes).includes('contentHtml'), 'MCP note response contains no article HTML snapshot').toBe(false);
    marks.push(...notes.marks);
    if (notes.nextOffset !== null) expect(notes.nextOffset).toBeGreaterThan(offset);
    offset = notes.nextOffset;
  }
  expect(offset, 'all note pages terminate').toBeNull();
  expect(marks).toEqual(saved.marks);
  const preview = await client.call('get_note_preview', { articleId: first.id, mode: 'feed', contentHash: saved.contentHash, group: 0 });
  expect(structured(preview)).toMatchObject({ articleId: first.id, mode: 'feed', contentHash: saved.contentHash, revision: saved.revision, group: 0, raw: true });
  const image = preview.content.find(block => block.type === 'image');
  expect(image?.mimeType).toBe('image/png'); expect(Boolean(image?.data)).toBe(true);
  pngDimensions(Buffer.from(image!.data!, 'base64'));
  const asset = first.images.find(image => image.status === 'cached');
  if (!asset) throw new Error('Owned RSS fixture image was not archived');
  const original = await client.call('get_article_image', { imageId: asset.id });
  expect(structured(original)).toMatchObject({ imageId: asset.id, articleId: first.id, contentHash: first.contentHash });
  const originalImage = original.content.find(block => block.type === 'image');
  expect(originalImage?.mimeType).toBe('image/png'); expect(Boolean(originalImage?.data)).toBe(true);
  pngDimensions(Buffer.from(originalImage!.data!, 'base64'));
  expect((await getAnnotation(request, first.id)).revision).toBe(saved.revision);
});

test('concurrent principals and the two read scopes cannot cross tenant or scope boundaries', async ({ request, playwright }) => {
  const session = await createAnnotationUser(request);
  const owned = await seedAnnotationArticles(request, session);
  const empty = await getAnnotation(request, owned.first.id);
  const saved = await putAnnotation(request, session, empty, annotationFixture(empty.context));
  const otherApi = await playwright.request.newContext({ baseURL });
  try {
    const otherSession = await createAnnotationUser(otherApi);
    const other = await seedAnnotationArticles(otherApi, otherSession);
    const otherEmpty = await getAnnotation(otherApi, other.first.id);
    const otherPayload = annotationFixture(otherEmpty.context);
    otherPayload.marks = otherPayload.marks.map(mark => ({ ...mark, text: '另一个账户的独立备注' }));
    const otherSaved = await putAnnotation(otherApi, otherSession, otherEmpty, otherPayload);
    const [articlesToken, notesToken, otherToken] = await Promise.all([
      createToken(request, session, ['articles:read']), createToken(request, session, ['notes:read']), createToken(otherApi, otherSession, ['articles:read', 'notes:read']),
    ]);
    const articleClient = new McpWitness(articlesToken.token), noteClient = new McpWitness(notesToken.token), otherClient = new McpWitness(otherToken.token);
    await Promise.all([articleClient.initialize(), noteClient.initialize(), otherClient.initialize()]);
    const allowedArticle = structured(await articleClient.call('get_article', { articleId: owned.first.id, offset: 0, limit: 1200 }));
    expect(JSON.stringify(allowedArticle)).toContain(fixtureQuote);
    await assertDeniedTool(articleClient, 'get_notes', { articleId: owned.first.id }, fixtureRemark);
    await assertDeniedTool(noteClient, 'get_article', { articleId: owned.first.id }, fixtureQuote);
    await assertDeniedTool(articleClient, 'search_notes', { query: '验收备注' }, fixtureRemark);
    await assertDeniedTool(noteClient, 'search_articles', { query: '持久存档' }, fixtureQuote);
    await assertDeniedTool(otherClient, 'get_article', { articleId: owned.first.id }, fixtureTitle, 'NOT_FOUND');
    await assertDeniedTool(otherClient, 'get_notes', { articleId: owned.first.id, contentHash: saved.contentHash }, fixtureRemark, 'NOT_FOUND');
    await assertDeniedTool(otherClient, 'get_note_preview', { articleId: owned.first.id, contentHash: saved.contentHash, group: 0 }, fixtureRemark, 'NOT_FOUND');
    const asset = owned.first.images.find(image => image.status === 'cached');
    if (!asset) throw new Error('Owned test image missing');
    await assertDeniedTool(otherClient, 'get_article_image', { imageId: asset.id }, asset.originalUrl, 'NOT_FOUND');
    const pairs = await Promise.all(Array.from({ length: 4 }, async () => {
      const [mine, theirs] = await Promise.all([
        noteClient.call('get_notes', { articleId: owned.first.id, mode: 'feed', contentHash: saved.contentHash, limit: 100 }),
        otherClient.call('get_notes', { articleId: other.first.id, mode: 'feed', contentHash: otherSaved.contentHash, limit: 100 }),
      ]);
      return [structured(mine) as unknown as NotesResult, structured(theirs) as unknown as NotesResult];
    }));
    for (const [mine, theirs] of pairs) {
      expect(mine.document.articleId).toBe(owned.first.id); expect(mine.marks).toEqual(saved.marks);
      expect(theirs.document.articleId).toBe(other.first.id); expect(theirs.marks).toEqual(otherSaved.marks);
    }
    const search = structured(await otherClient.call('search_notes', { query: '验收备注', limit: 20 }));
    expect(search.items).toEqual([]); expect(search.total).toBe(0);
  } finally { await otherApi.dispose(); }
});

test('tokens are shown once, session+CSRF managed, read-only, immediately revocable and not accepted in query strings', async ({ request, playwright }) => {
  const session = await createAnnotationUser(request);
  const credential = await createToken(request, session, ['notes:read']);
  expect(await deniedHttp()).toBe(401);
  expect(await deniedHttp(undefined, new URL(baseURL).origin, '?token=DO_NOT_USE_PLACEHOLDER')).toBe(401);
  expect(await deniedHttp(credential.token, new URL(baseURL).origin, '?unsupported=1')).toBe(400);
  expect(await deniedHttp(credential.token, 'https://untrusted.example.test')).toBe(403);
  const listing = await request.get('/api/mcp-tokens');
  expect(listing.status()).toBe(200);
  const text = await listing.text();
  expect(text.includes(credential.token), 'token listing never repeats bearer secret').toBe(false);
  const items = (JSON.parse(text) as { items: RecordValue[] }).items;
  expect(items.length).toBeGreaterThan(0);
  expect(items.every(item => !('token' in item) && !('hash' in item) && !('tokenHash' in item) && !('token_hash' in item)), 'token metadata contains neither raw token nor hash').toBe(true);
  const noCsrf = await request.post('/api/mcp-tokens', { data: { name: '拒绝无 CSRF 创建', scopes: ['notes:read'] } });
  expect(noCsrf.status()).toBe(403);
  const writeScope = await request.post('/api/mcp-tokens', { headers: csrf(session), data: { name: '拒绝写权限', scopes: ['notes:write'] } });
  expect([400, 422]).toContain(writeScope.status());
  const other = await playwright.request.newContext({ baseURL });
  try {
    const otherSession = await createAnnotationUser(other);
    const denial = await other.delete(`/api/mcp-tokens/${credential.access.id}`, { headers: csrf(otherSession) });
    expect([403, 404]).toContain(denial.status());
    const client = new McpWitness(credential.token); await client.initialize();
    await client.tools();
    const revoked = await request.delete(`/api/mcp-tokens/${credential.access.id}`, { headers: csrf(session) });
    expect(revoked.status()).toBe(204);
    expect(await deniedHttp(credential.token)).toBe(401);
    // Revocation applies to a previously initialized connection, not just new handshakes.
    await expect(client.tools()).rejects.toThrow(/HTTP status/);
    const remaining = await request.get('/api/mcp-tokens');
    const remainingItems = (await remaining.json()).items as { id: string }[];
    expect(remainingItems.some(item => item.id === credential.access.id)).toBe(false);
  } finally { await other.dispose(); }
});
