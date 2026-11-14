import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function worker() {
  const events: Record<string, (event: any) => void> = {};
  const cached = new Map<string, Response>();
  const source = (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')).replace('/* SHELL_ASSETS */ []', JSON.stringify(['/', '/index.html', '/assets/app.js']));
  runInNewContext(source, { URL, Response, fetch: async () => { throw new TypeError('offline'); }, self: { location: { origin: 'https://feedink.test' }, addEventListener: (name: string, callback: (event: any) => void) => { events[name] = callback; }, clients: { claim: async () => {} } }, caches: { keys: async () => [], match: async (path: string) => cached.get(path), open: async () => ({ match: async (path: string) => cached.get(path), addAll: async () => {} }) } });
  return { events, cached };
}
test('service worker never intercepts authenticated API or cross-origin requests', async () => {
  const { events } = await worker();
  for (const url of ['https://feedink.test/api/session', 'https://feedink.test/api/articles/one', 'https://feedink.test/api/assets/image', 'https://feedink.test/api/export/archive', 'https://foreign.test/assets/app.js']) {
    let handled = false; events.fetch({ request: { method: 'GET', url, mode: 'cors' }, respondWith: () => { handled = true; } }); assert.equal(handled, false, url);
  }
});
test('service worker ignores mutations and non-allowlisted resources', async () => {
  const { events } = await worker();
  let handled = false;
  for (const request of [{ method: 'POST', url: 'https://feedink.test/', mode: 'navigate' }, { method: 'GET', url: 'https://feedink.test/private-file', mode: 'cors' }]) events.fetch({ request, respondWith: () => { handled = true; } });
  assert.equal(handled, false);
});
test('offline navigation restores only the public application shell', async () => {
  const { events, cached } = await worker(); cached.set('/index.html', new Response('<div id="root"></div>'));
  let result: Promise<Response> | undefined;
  events.fetch({ request: { method: 'GET', url: 'https://feedink.test/?article=private', mode: 'navigate' }, respondWith: (response: Promise<Response>) => { result = response; } });
  assert.equal(await (await result)?.text(), '<div id="root"></div>');
});
