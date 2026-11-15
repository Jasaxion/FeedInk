import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

// The browser-runner helper is native ESM, outside the application's TS API.
const { diagnosticURL, diagnosticStackKind, documentClass, attributedDiagnostic, fixturePageErrors, installRuntimeWitness } = await import(new URL('./fixture-page-errors.mjs', import.meta.url).href);
const ownedOrigin = 'http://127.0.0.1:43210';
const page = {};
const outage = { id: 1, startedAt: 100, endedAt: 1000, verifiedUnreachable: true };
const options = { browserName: 'webkit', ownedOrigin, apiPaths: ['/api/session', '/api/articles'], origin: {
  failureWindowAt: (at: number) => at >= 100 && at < 1000 ? outage : null,
  failureWindowOverlapping: (start: number, end: number) => start <= end && end >= 100 && start < 1000 ? outage : null,
} };
const nativeError = (path = '/api/session') => ({ name: 'Fetch API cannot load http', message: `/127.0.0.1:43210${path} due to access control checks.`, stack: '', at: 500, page });
const failedFetch = (path = '/api/session') => ({ source: 'native-fetch', url: `${ownedOrigin}${path}`, method: 'GET', documentClass: 'application', networkFailure: true, cancelled: false, startedAt: 400, at: 490, deliveredAt: 501, page, used: false });

test('fixture-page-errors attributes exact native GET rejection, including empty WebKit callFrames, in a verified outage', () => {
  for (const path of ['/api/session', '/api/articles?scope=all&sort=newest&limit=50']) {
    const failure = failedFetch(path);
    const error = nativeError(path);
    assert.equal(diagnosticURL(error, ownedOrigin, options.apiPaths), `${ownedOrigin}${path}`);
    assert.equal(attributedDiagnostic(error, [failure], options), failure);
    const header = `Fetch API cannot load ${ownedOrigin}${path} due to access control checks.`;
    for (const stack of [header, `${header}\n`]) assert.equal(attributedDiagnostic({ ...error, stack }, [failure], options), failure);
  }
});

test('fixture-page-errors refuses unknown, real JS, Node-looking stacks, foreign-origin and unowned-path diagnostics', () => {
  for (const change of [
    { name: 'Error' }, { name: 'TypeError' }, { name: 'XMLHttpRequest cannot load http' },
    { stack: 'at application.js:1:1' }, { stack: undefined },
    { stack: 'Error: native fetch\n    at parseError2 (/node_modules/playwright-core/lib/coreBundle.js:59590:3)' },
    { stack: `Fetch API cannot load ${ownedOrigin}/api/session due to access control checks.\n    at application.js:1:1` },
    { message: 'Load failed' }, { message: '/127.0.0.1:43210/api/session.' },
    { message: '/127.0.0.1:43211/api/session due to access control checks.' },
    { message: '/127.0.0.1:43210/api/session/../session due to access control checks.' },
    { message: '/127.0.0.1:43210/api/session#fragment due to access control checks.' },
    { message: '/127.0.0.1:43210/api/settings due to access control checks.' },
  ]) assert.equal(attributedDiagnostic({ ...nativeError(), ...change }, [failedFetch()], options), null);
  assert.equal(diagnosticStackKind({ stack: 'Error\n    at parseError2 (/node_modules/playwright-core/lib/coreBundle.js:1:1)' }, null), 'node-client-frames');
});

test('fixture-page-errors requires same-page, one-to-one native rejection; protocol requestfailed alone is insufficient', () => {
  assert.equal(attributedDiagnostic(nativeError(), [], options), null);
  assert.equal(attributedDiagnostic(nativeError(), [failedFetch()], { ...options, browserName: 'chromium' }), null);
  assert.equal(attributedDiagnostic(nativeError(), [failedFetch()], { ...options, origin: { ...options.origin, failureWindowOverlapping: () => ({ ...outage, verifiedUnreachable: false }) } }), null);
  for (const change of [
    { page: {} }, { method: 'POST' }, { source: 'playwright' }, { documentClass: 'fixture-document' },
    { networkFailure: false }, { cancelled: true }, { used: true }, { startedAt: 1000, at: 1010 },
    { startedAt: 80, at: 99 }, { startedAt: 500, at: 490 }, { deliveredAt: 1601 },
    { url: `${ownedOrigin}/api/articles` }, { url: `${ownedOrigin}/api/session?other=1` },
  ]) assert.equal(attributedDiagnostic(nativeError(), [{ ...failedFetch(), ...change }], options), null);
  for (const at of [399, 1600]) assert.equal(attributedDiagnostic({ ...nativeError(), at }, [failedFetch()], options), null);
});

test('fixture-page-errors allows evidenced delivery after resume, not an online failure or an old outage waiver', () => {
  const delayed = { ...failedFetch(), startedAt: 990, at: 1005, deliveredAt: 1010 };
  const error = { ...nativeError(), at: 1011 };
  assert.equal(options.origin.failureWindowAt(error.at), null);
  assert.equal(attributedDiagnostic(error, [delayed], options), delayed);
  assert.equal(attributedDiagnostic(error, [{ ...delayed, startedAt: 1001 }], options), null);
  assert.equal(attributedDiagnostic({ ...error, at: 2011 }, [delayed], options), null);
  delayed.used = true;
  assert.equal(attributedDiagnostic(error, [delayed], options), null);
});

test('fixture-page-errors classifies only exact original-site fixture documents, not escaped app or asset sources', () => {
  const scoped = { ...options, fixtureDocumentPaths: ['/original', '/denied'] };
  assert.equal(documentClass(`${ownedOrigin}/original`, scoped), 'fixture-document');
  assert.equal(documentClass(`${ownedOrigin}/denied`, scoped), 'fixture-document');
  for (const path of ['/escaped', '/assets/app.js', '/original?app=1']) assert.equal(documentClass(`${ownedOrigin}${path}`, scoped), 'application');
  assert.equal(documentClass('', scoped), 'unknown');
  assert.equal(documentClass('https://untrusted.invalid/original', scoped), 'foreign');
});

function observerHarness() {
  const pageHandlers = new Map<string, (...args: any[]) => void>();
  const contextHandlers = new Map<string, (...args: any[]) => void>();
  let report: (source: object, event: object) => void = () => {};
  const observedPage = { frames: () => [], url: () => `${ownedOrigin}/escaped`, on: (name: string, handler: (...args: any[]) => void) => pageHandlers.set(name, handler), evaluate: async () => [] };
  const context = {
    exposeBinding: async (_name: string, callback: typeof report) => { report = callback; },
    addInitScript: async () => {}, on: (name: string, handler: (...args: any[]) => void) => contextHandlers.set(name, handler), pages: () => [observedPage],
  };
  return { context, observedPage, report: (event: object) => report({ page: observedPage }, event),
    error: (error: object, url = '') => contextHandlers.get('weberror')!({ error: () => error, page: () => observedPage, location: () => ({ url }) }) };
}

test('fixture-page-errors independent runtime witnesses fail even alongside an otherwise attributable native diagnostic', async () => {
  for (const kind of ['error', 'unhandledrejection']) {
    const harness = observerHarness();
    const witness = await fixturePageErrors(harness.context, { ...options, origin: { failureWindowAt: () => outage, failureWindowOverlapping: () => outage } });
    const now = Date.now();
    harness.error(nativeError());
    harness.report({ ...failedFetch(), kind: 'native-fetch', startedAt: now - 1, at: now });
    harness.report({ kind });
    await assert.rejects(() => witness.assertClean(), /Independent ErrorEvent\/unhandledrejection witness/);
  }
});

test('fixture-page-errors does not excuse app errors in an original-link popup, or errors with unknown source', async () => {
  for (const source of ['/original', '/escaped', '/assets/app.js', '']) {
    const harness = observerHarness();
    const witness = await fixturePageErrors(harness.context, { ...options, fixtureDocumentPaths: ['/original', '/denied'] });
    harness.error({ name: 'SecurityError', message: 'fixture escape', stack: 'fixture stack' }, source ? `${ownedOrigin}${source}` : '');
    if (source === '/original') await witness.assertClean();
    else await assert.rejects(() => witness.assertClean(), /Unexpected pageerror/);
  }
});

test('fixture-page-errors native probe calls fetch unchanged and preserves response and rejection identities', async () => {
  const reports: any[] = [];
  const calls: any[] = [];
  const response = {};
  const rejection = new TypeError('Load failed');
  let fail = false;
  const window = { fetch: function(this: any, ...args: any[]) { calls.push({ receiver: this, args }); return fail ? Promise.reject(rejection) : Promise.resolve(response); },
    addEventListener: () => {}, __fixtureRuntimeReport: async (event: object) => { reports.push(event); } };
  // Same Object/TypeError constructors keep the synthetic RequestInit and error
  // in the probe's realm, as they are in the actual browser.
  const install = vm.runInNewContext(`(${installRuntimeWitness.toString()})`, { window, location: { href: ownedOrigin }, URL, Object, TypeError, Date });
  install(options);
  const init = { method: 'GET', cache: 'no-store' };
  assert.equal(await window.fetch('/api/session', init), response);
  assert.equal(calls[0].receiver, window);
  assert.equal(calls[0].args[0], '/api/session');
  assert.equal(calls[0].args[1], init);
  assert.equal(reports.length, 0);
  fail = true;
  await assert.rejects(window.fetch('/api/session', init), error => error === rejection);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].url, `${ownedOrigin}/api/session`);
  assert.equal(reports[0].networkFailure, true);
  for (const input of ['/api/settings', 'https://untrusted.invalid/api/session']) await assert.rejects(window.fetch(input), error => error === rejection);
  await assert.rejects(window.fetch('/api/session', { method: 'POST' }), error => error === rejection);
  assert.equal(reports.length, 1);
  await assert.rejects(window.fetch('/api/session', { signal: { aborted: true } }), error => error === rejection);
  assert.equal(reports[1].cancelled, true);
});
