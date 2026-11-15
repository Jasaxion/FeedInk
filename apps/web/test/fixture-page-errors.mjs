import assert from 'node:assert/strict';

// WebKit ThreadableLoader::logError emits this exact JS/error diagnostic.
// Pinned playwright-core@1.65.1 coreBundle.js: wkPage _onConsoleMessage uses
// text + '\n' + callFrames.join('\n') (including an EMPTY callFrames array).
// splitErrorMessage discards ':/' at the first colon. Client errors.ts
// parseError2 assigns wire stack || ''; it does NOT reconstruct a Node stack.
export function diagnosticURL(error, ownedOrigin, apiPaths) {
  if (error.name !== 'Fetch API cannot load http' || typeof error.message !== 'string') return null;
  const suffix = ' due to access control checks.';
  if (!error.message.endsWith(suffix)) return null;
  const raw = `http:/${error.message.slice(0, -suffix.length)}`;
  try {
    const url = new URL(raw);
    if (url.href !== raw || url.origin !== ownedOrigin || !apiPaths.includes(url.pathname) || url.hash || url.username || url.password) return null;
    return raw;
  } catch { return null; }
}

export function diagnosticStackKind(error, url) {
  if (error.stack === '') return 'empty';
  const header = `Fetch API cannot load ${url} due to access control checks.`;
  if (url && (error.stack === header || error.stack === `${header}\n`)) return 'native-header';
  if (typeof error.stack !== 'string') return 'missing';
  if (url && error.stack.startsWith(`${header}\n`)) return 'native-header-with-frames';
  // Diagnostic only: neither Node-looking nor browser frames grant a waiver.
  if (/\n\s+at .*\bparseError2?\b.*(?:coreBundle|errors)\.js:\d+:\d+/.test(error.stack)) return 'node-client-frames';
  return error.stack.includes('\n') ? 'other-frames' : 'other-header';
}

export function documentClass(raw, { ownedOrigin, fixtureDocumentPaths = [] }) {
  try {
    const url = new URL(raw);
    if (url.origin !== ownedOrigin) return 'foreign';
    return fixtureDocumentPaths.includes(url.pathname) && !url.search && !url.hash ? 'fixture-document' : 'application';
  } catch { return 'unknown'; }
}

export function attributedDiagnostic(error, failures, options) {
  if (options.browserName !== 'webkit') return null;
  const url = diagnosticURL(error, options.ownedOrigin, options.apiPaths);
  if (!url || !['empty', 'native-header'].includes(diagnosticStackKind(error, url))) return null;
  return failures.find(failure => {
    if (failure.used || failure.page !== error.page || failure.url !== url || failure.method !== 'GET') return false;
    // Browser timestamps and Node outage timestamps both use the host wall
    // clock. Receipt timestamps are separate: protocol events can be delivered
    // after listener resumption. The actual native fetch MUST overlap a TCP-
    // verified outage; a recently paused origin alone is never sufficient.
    // PW requestfailed is diagnostic-only: counting it as a second candidate
    // would let one underlying fetch excuse two page errors.
    return failure.source === 'native-fetch' && failure.documentClass === 'application' && failure.networkFailure && !failure.cancelled &&
      failure.startedAt <= failure.at && failure.at <= failure.deliveredAt + 1000 &&
      Boolean(options.origin.failureWindowOverlapping(failure.startedAt, failure.at)?.verifiedUnreachable) &&
      error.at >= failure.startedAt && Math.abs(error.at - failure.deliveredAt) <= 1000;
  }) || null;
}

export function installRuntimeWitness({ ownedOrigin, apiPaths, fixtureDocumentPaths = [] }) {
  const events = [];
  Object.defineProperty(window, '__fixtureRuntimeEvents', { value: events });
  const url = new URL(location.href);
  const scope = url.origin === ownedOrigin && fixtureDocumentPaths.includes(url.pathname) && !url.search && !url.hash ? 'fixture-document' : 'application';
  const report = event => {
    try { void window.__fixtureRuntimeReport(event).catch(() => events.push('binding-failed')); }
    catch { events.push('binding-failed'); }
  };
  const runtime = kind => {
    // These are separate original-site fixture documents, not FeedInk code.
    if (scope === 'fixture-document') return;
    events.push(kind);
    report({ kind });
  };
  window.addEventListener('error', event => { if (event instanceof ErrorEvent) runtime('error'); }, true);
  window.addEventListener('unhandledrejection', () => runtime('unhandledrejection'), true);
  const nativeFetch = window.fetch;
  window.fetch = function(...args) {
    const startedAt = Date.now();
    // Call first, with the original receiver and arguments. Never replace a
    // native response/rejection or await a reporting binding on the app path.
    const promise = Reflect.apply(nativeFetch, this, args);
    const [input, init] = args;
    // FeedInk's API seam uses string URLs + plain RequestInit data properties.
    // Leave other inputs untouched; do not re-run user coercions/getters.
    if (scope !== 'application' || typeof input !== 'string' || (init != null && Object.getPrototypeOf(init) !== Object.prototype)) return promise;
    const method = init && Object.getOwnPropertyDescriptor(init, 'method');
    const signal = init && Object.getOwnPropertyDescriptor(init, 'signal');
    if (method && (!('value' in method) || method.value !== undefined && method.value !== 'GET') || signal && !('value' in signal)) return promise;
    let requestURL;
    try { requestURL = new URL(input, location.href); } catch { return promise; }
    if (requestURL.origin !== ownedOrigin || !apiPaths.includes(requestURL.pathname) || requestURL.hash || requestURL.username || requestURL.password) return promise;
    return promise.then(response => response, error => {
      report({ kind: 'native-fetch', url: requestURL.href, method: 'GET', startedAt, at: Date.now(), documentClass: scope,
        networkFailure: error instanceof TypeError && error.message === 'Load failed', cancelled: Boolean(signal?.value?.aborted) });
      // Return this chain to the caller. A handled rejection stays handled;
      // an unhandled rejection still triggers the independent witness.
      throw error;
    });
  };
}

export async function fixturePageErrors(context, options) {
  const errors = [], failures = [], runtimeEvents = [];
  const requests = new WeakMap();
  await context.exposeBinding('__fixtureRuntimeReport', (source, event) => {
    if (event.kind === 'native-fetch') failures.push({ ...event, source: 'native-fetch', page: source.page, deliveredAt: Date.now(), used: false });
    else runtimeEvents.push(event.kind);
  });
  await context.addInitScript(installRuntimeWitness, { ownedOrigin: options.ownedOrigin, apiPaths: options.apiPaths, fixtureDocumentPaths: options.fixtureDocumentPaths });
  // The pinned client exposes the protocol source location on WebError, unlike
  // Page.pageerror. Only an exact fixture DOCUMENT source can be excluded;
  // unknown locations and application code in an original-link popup still fail.
  context.on('weberror', webError => {
    const error = webError.error();
    const page = webError.page(), sourceURL = webError.location()?.url;
    const frame = page?.frames().find(frame => frame.url() === sourceURL);
    errors.push({ name: error.name, message: error.message, stack: error.stack, page,
      frameClass: frame ? frame === page.mainFrame() ? 'main' : 'child' : 'script-or-unknown',
      sourceClass: documentClass(sourceURL, options), at: Date.now() });
  });
  const observe = page => {
    page.on('request', request => requests.set(request, { responded: false }));
    page.on('response', response => { const state = requests.get(response.request()); if (state) state.responded = true; });
    page.on('requestfailed', request => failures.push({
      page, url: request.url(), method: request.method(), resourceType: request.resourceType(),
      redirected: Boolean(request.redirectedFrom()), responded: requests.get(request)?.responded !== false,
      failed: Boolean(request.failure()?.errorText), cancelled: /cancel|abort/i.test(request.failure()?.errorText || ''), at: Date.now(), used: false,
    }));
  };
  context.on('page', observe);
  for (const page of context.pages()) observe(page);
  return {
    async assertClean() {
      const currentEvents = [];
      for (const page of context.pages()) {
        currentEvents.push(...await page.evaluate(() => {
          if (!Array.isArray(window.__fixtureRuntimeEvents)) throw new Error('runtime witness missing');
          return window.__fixtureRuntimeEvents;
        }));
      }
      assert.deepEqual([...runtimeEvents, ...currentEvents], [], 'Independent ErrorEvent/unhandledrejection witness');
      const unexpected = [];
      let attributed = 0;
      for (const error of errors) {
        if (error.sourceClass === 'fixture-document') continue;
        const failure = attributedDiagnostic(error, failures, options);
        if (failure) { failure.used = true; attributed++; continue; }
        const url = diagnosticURL(error, options.ownedOrigin, options.apiPaths);
        // Finite categories only: no URLs, exception text, bodies or raw stacks.
        unexpected.push({ errorName: ['Error', 'TypeError', 'ReferenceError', 'SecurityError', 'SyntaxError', 'AbortError', 'Fetch API cannot load http'].includes(error.name) ? error.name : 'other',
          sourceClass: error.sourceClass, frameClass: error.frameClass, pageClass: documentClass(error.page?.url(), options),
          knownFetchShape: Boolean(url), stackKind: diagnosticStackKind(error, url),
          fetchSuffix: error.message?.endsWith(' due to access control checks.') === true,
          pausedOrigin: Boolean(options.origin.failureWindowAt(error.at)?.verifiedUnreachable),
          failedFetchCount: failures.filter(item => item.resourceType === 'fetch').length,
          nativeFailureCount: failures.filter(item => item.source === 'native-fetch').length,
          matchingURLFailureCount: failures.filter(item => item.page === error.page && item.url === url).length,
          matchingNetworkFailureCount: failures.filter(item => item.source === 'native-fetch' && item.page === error.page && item.url === url && item.networkFailure && !item.cancelled).length,
          overlappingNativeFailureCount: failures.filter(item => item.source === 'native-fetch' && options.origin.failureWindowOverlapping(item.startedAt, item.at)?.verifiedUnreachable).length });
      }
      assert.deepEqual(unexpected, [], 'Unexpected pageerror (safe diagnostic metadata)');
      if (attributed) console.log(`Attributed ${attributed} native WebKit fetch diagnostics to verified fixture origin failures; runtime witnesses clean.`);
    },
  };
}

// Real browser sensitivity, on a separate non-application page: neither a throw
// nor an unhandled rejection may disappear, even with the native diagnostic text.
export async function verifyRuntimeErrorWitness(browser) {
  for (const mode of ['plain', 'lookalike', 'native-fetch']) {
    const context = await browser.newContext();
    try {
      const witness = await fixturePageErrors(context, { browserName: 'webkit', ownedOrigin: 'http://127.0.0.1:1', apiPaths: ['/api/session'], origin: { failureWindowAt: () => null, failureWindowOverlapping: () => null } });
      const page = await context.newPage();
      await page.goto('data:text/html,<title>Runtime witness sensitivity</title>');
      await witness.assertClean();
      await page.evaluate(mode => {
        const error = () => mode === 'lookalike'
          ? Object.assign(new Error('/127.0.0.1:1/api/session due to access control checks.'), { name: 'Fetch API cannot load http', stack: '' })
          : new Error('fixture runtime failure');
        setTimeout(() => { throw error(); }, 0);
        if (mode === 'native-fetch') void fetch('http://127.0.0.1:1/api/session');
        else void Promise.reject(error());
      }, mode);
      await page.waitForFunction(() => window.__fixtureRuntimeEvents.includes('error') && window.__fixtureRuntimeEvents.includes('unhandledrejection'));
      await page.reload();
      await assert.rejects(() => witness.assertClean(), /Independent ErrorEvent\/unhandledrejection witness/);
    } finally { await context.close(); }
  }
}
