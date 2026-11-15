import assert from 'node:assert/strict';
import test from 'node:test';

// The browser-runner helper is native ESM, outside the application's TS API.
const { diagnosticURL, attributedDiagnostic, fixturePageErrors } = await import(new URL('./fixture-page-errors.mjs', import.meta.url).href);
const ownedOrigin = 'http://127.0.0.1:43210';
const page = {};
const window = { id: 1, verifiedUnreachable: true };
const options = { browserName: 'webkit', ownedOrigin, apiPaths: ['/api/session', '/api/articles'], origin: { failureWindowAt: (at: number) => at >= 100 && at < 2000 ? window : null } };
const nativeError = (path = '/api/session') => ({ name: 'Fetch API cannot load http', message: `/127.0.0.1:43210${path} due to access control checks.`, stack: '', at: 500, page });
const failedFetch = (path = '/api/session') => ({ url: `${ownedOrigin}${path}`, method: 'GET', resourceType: 'fetch', redirected: false, responded: false, failed: true, cancelled: false, at: 501, page, used: false });

test('fixture-page-errors attributes only the exact WebKit message and failed owned fetch in a verified outage', () => {
  for (const path of ['/api/session', '/api/articles?scope=all&sort=newest&limit=50']) {
    const failure = failedFetch(path);
    assert.equal(diagnosticURL(nativeError(path), ownedOrigin, options.apiPaths), `${ownedOrigin}${path}`);
    assert.equal(attributedDiagnostic(nativeError(path), [failure], options), failure);
  }
});

test('fixture-page-errors refuses unknown, real JS, foreign-origin and unowned-path diagnostics', () => {
  for (const change of [
    { name: 'Error' }, { name: 'TypeError' }, { name: 'XMLHttpRequest cannot load http' },
    { stack: 'at application.js:1:1' }, { stack: undefined },
    { message: 'Load failed' }, { message: '/127.0.0.1:43210/api/session.' },
    { message: '/127.0.0.1:43211/api/session due to access control checks.' },
    { message: '/127.0.0.1:43210/api/session/../session due to access control checks.' },
    { message: '/127.0.0.1:43210/api/session#fragment due to access control checks.' },
    { message: '/127.0.0.1:43210/api/settings due to access control checks.' },
  ]) assert.equal(attributedDiagnostic({ ...nativeError(), ...change }, [failedFetch()], options), null);
});

test('fixture-page-errors requires same-page, one-to-one, timely failed fetch attribution, never an online waiver', () => {
  assert.equal(attributedDiagnostic(nativeError(), [], options), null);
  assert.equal(attributedDiagnostic(nativeError(), [failedFetch()], { ...options, browserName: 'chromium' }), null);
  assert.equal(attributedDiagnostic(nativeError(), [failedFetch()], { ...options, origin: { failureWindowAt: () => ({ id: 1, verifiedUnreachable: false }) } }), null);
  for (const change of [{ at: 99 }, { at: 2000 }]) assert.equal(attributedDiagnostic({ ...nativeError(), ...change }, [failedFetch()], options), null);
  for (const change of [
    { page: {} }, { method: 'POST' }, { resourceType: 'image' }, { redirected: true },
    { responded: true }, { failed: false }, { cancelled: true }, { used: true }, { at: 99 }, { at: 1600 }, { at: 2000 },
    { url: `${ownedOrigin}/api/articles` }, { url: `${ownedOrigin}/api/session?other=1` },
  ]) assert.equal(attributedDiagnostic(nativeError(), [{ ...failedFetch(), ...change }], options), null);
  const otherWindow = { ...options, origin: { failureWindowAt: (at: number) => ({ id: at === 500 ? 1 : 2, verifiedUnreachable: true }) } };
  assert.equal(attributedDiagnostic(nativeError(), [failedFetch()], otherWindow), null);
});

test('fixture-page-errors independent runtime witnesses fail even alongside an otherwise attributable native diagnostic', async () => {
  for (const kind of ['error', 'unhandledrejection']) {
    const handlers = new Map<string, (...args: any[]) => void>();
    let report: (source: object, kind: string) => void = () => {};
    const observedPage = { on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler), evaluate: async () => [] };
    const context = {
      exposeBinding: async (_name: string, callback: typeof report) => { report = callback; },
      addInitScript: async () => {}, on: () => {}, pages: () => [observedPage],
    };
    const witness = await fixturePageErrors(context, { ...options, origin: { failureWindowAt: () => window } });
    const request = { url: () => `${ownedOrigin}/api/session`, method: () => 'GET', resourceType: () => 'fetch', redirectedFrom: () => null, failure: () => ({ errorText: 'fixture failure' }) };
    handlers.get('request')!(request);
    handlers.get('pageerror')!(nativeError());
    handlers.get('requestfailed')!(request);
    report({}, kind);
    await assert.rejects(() => witness.assertClean(), /Independent ErrorEvent\/unhandledrejection witness/);
  }
});
