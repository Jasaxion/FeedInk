import assert from 'node:assert/strict';

// WebKit Source/WebCore/loader/ThreadableLoader.cpp, ThreadableLoader::logError:
// https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/ThreadableLoader.cpp
// emits "Fetch API cannot load <URL> due to access control checks." as JS/error.
// Playwright lib/server/webkit/wkPage.js _onConsoleMessage turns ALL JS/error
// console messages into pageerror, with stack='' when no stackTrace is present.
// Also verified in the pinned playwright-core@1.65.1 package's lib/coreBundle.js.
// lib/utils/isomorphic/stackTrace.js splitErrorMessage splits at the first ':'
// and discards TWO characters, including the first slash of an http:// URL.
// Do not accept other message shapes if either upstream implementation changes.
export function diagnosticURL(error, ownedOrigin, apiPaths) {
  if (error.name !== 'Fetch API cannot load http' || error.stack !== '') return null;
  const suffix = ' due to access control checks.';
  if (!error.message.endsWith(suffix)) return null;
  const raw = `http:/${error.message.slice(0, -suffix.length)}`;
  try {
    const url = new URL(raw);
    if (url.href !== raw || url.origin !== ownedOrigin || !apiPaths.includes(url.pathname) || url.hash || url.username || url.password) return null;
    return raw;
  } catch { return null; }
}

export function attributedDiagnostic(error, failures, { browserName, ownedOrigin, apiPaths, origin }) {
  if (browserName !== 'webkit') return null;
  const url = diagnosticURL(error, ownedOrigin, apiPaths);
  const window = origin.failureWindowAt(error.at);
  if (!url || !window?.verifiedUnreachable) return null;
  return failures.find(failure => !failure.used && failure.page === error.page && failure.url === url &&
    failure.method === 'GET' && failure.resourceType === 'fetch' && !failure.redirected && !failure.responded &&
    failure.failed && !failure.cancelled && origin.failureWindowAt(failure.at)?.id === window.id && Math.abs(failure.at - error.at) <= 1000) || null;
}

function installRuntimeWitness() {
  // Binding deliveries are retained in Node across navigations. The local copy
  // also detects a lost/rejected binding delivery in the current document.
  const events = [];
  Object.defineProperty(window, '__fixtureRuntimeEvents', { value: events });
  const report = kind => {
    events.push(kind);
    void window.__fixtureRuntimeReport(kind).catch(() => events.push('binding-failed'));
  };
  window.addEventListener('error', event => { if (event instanceof ErrorEvent) report('error'); }, true);
  window.addEventListener('unhandledrejection', () => report('unhandledrejection'), true);
}

export async function fixturePageErrors(context, options) {
  const errors = [], failures = [], runtimeEvents = [];
  const requests = new WeakMap();
  await context.exposeBinding('__fixtureRuntimeReport', (_source, kind) => { runtimeEvents.push(kind); });
  await context.addInitScript(installRuntimeWitness);
  const observe = page => {
    page.on('pageerror', error => errors.push({ name: error.name, message: error.message, stack: error.stack, page, at: performance.now() }));
    page.on('request', request => requests.set(request, { responded: false }));
    page.on('response', response => { const state = requests.get(response.request()); if (state) state.responded = true; });
    page.on('requestfailed', request => failures.push({
      page, url: request.url(), method: request.method(), resourceType: request.resourceType(),
      redirected: Boolean(request.redirectedFrom()), responded: requests.get(request)?.responded !== false,
      failed: Boolean(request.failure()?.errorText), cancelled: /cancel|abort/i.test(request.failure()?.errorText || ''), at: performance.now(), used: false,
    }));
  };
  context.on('page', observe);
  for (const page of context.pages()) observe(page);
  return {
    async assertClean() {
      const currentEvents = [];
      for (const page of context.pages()) {
        // This barrier also lets earlier binding/requestfailed messages arrive.
        currentEvents.push(...await page.evaluate(() => {
          if (!Array.isArray(window.__fixtureRuntimeEvents)) throw new Error('runtime witness missing');
          return window.__fixtureRuntimeEvents;
        }));
      }
      assert.deepEqual([...runtimeEvents, ...currentEvents], [], 'Independent ErrorEvent/unhandledrejection witness');
      const unexpected = [];
      let attributed = 0;
      for (const error of errors) {
        const failure = attributedDiagnostic(error, failures, options);
        if (failure) { failure.used = true; attributed++; continue; }
        // No URLs, page text, exception text, request bodies or stack contents.
        // Unknown shapes still FAIL, with only structural diagnostics for CI.
        unexpected.push({ knownFetchName: error.name === 'Fetch API cannot load http',
          knownFetchShape: Boolean(diagnosticURL(error, options.ownedOrigin, options.apiPaths)),
          stackless: error.stack === '', pausedOrigin: Boolean(options.origin.failureWindowAt(error.at)?.verifiedUnreachable),
          failedFetchCount: failures.filter(item => item.resourceType === 'fetch').length,
          matchingURLFailureCount: failures.filter(item => item.page === error.page && item.url === diagnosticURL(error, options.ownedOrigin, options.apiPaths)).length });
      }
      assert.deepEqual(unexpected, [], 'Unexpected pageerror (safe diagnostic metadata)');
      if (attributed) console.log(`Attributed ${attributed} native WebKit fetch diagnostics to verified fixture origin failures; runtime witnesses clean.`);
    },
  };
}

// Real browser sensitivity, on a separate non-application page: neither a throw
// nor an unhandled rejection may disappear, even with the native diagnostic text.
export async function verifyRuntimeErrorWitness(browser) {
  for (const lookalike of [false, true]) {
    const context = await browser.newContext();
    try {
      const witness = await fixturePageErrors(context, { browserName: 'webkit', ownedOrigin: 'http://127.0.0.1:1', apiPaths: ['/api/session'], origin: { failureWindowAt: () => null } });
      const page = await context.newPage();
      await page.goto('data:text/html,<title>Runtime witness sensitivity</title>');
      await witness.assertClean();
      await page.evaluate(lookalike => {
        const error = () => lookalike
          ? Object.assign(new Error('/127.0.0.1:1/api/session due to access control checks.'), { name: 'Fetch API cannot load http', stack: '' })
          : new Error('fixture runtime failure');
        setTimeout(() => { throw error(); }, 0);
        void Promise.reject(error());
      }, lookalike);
      await page.waitForFunction(() => window.__fixtureRuntimeEvents.includes('error') && window.__fixtureRuntimeEvents.includes('unhandledrejection'));
      await page.reload();
      await assert.rejects(() => witness.assertClean(), /Independent ErrorEvent\/unhandledrejection witness/);
    } finally { await context.close(); }
  }
}
