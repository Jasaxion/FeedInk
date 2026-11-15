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
  // Client reconstruction frames are not WebKit native call frames.
  if (/\n\s+at .*\bparseError2?\b.*(?:coreBundle|errors)\.js:\d+:\d+/.test(error.stack)) return 'node-client-frames';
  if (url && error.stack.startsWith(`${header}\n`) && error.stack.slice(header.length + 1).split('\n').every(line => /^    at .+ \(.*:\d+:\d+\)$/.test(line))) return 'native-header-with-frames';
  return error.stack.includes('\n') ? 'other-frames' : 'other-header';
}

export function documentClass(raw, { ownedOrigin, fixtureDocumentPaths = [] }) {
  try {
    const url = new URL(raw);
    if (url.origin !== ownedOrigin) return 'foreign';
    return fixtureDocumentPaths.includes(url.pathname) && !url.search && !url.hash ? 'fixture-document' : 'application';
  } catch { return 'unknown'; }
}

// Categories are diagnostic only, never exclusions. Do not print arbitrary
// exception messages, source URLs, or stacks into public CI output.
export function safeFailureKind(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/Cannot redefine property: (?:__fixtureRuntimeEvents|__fixtureRuntimeWitness|__fixtureRuntimeFlush)$/.test(message)) return 'witness-property-redefinition';
  if (/^(?:window\.)?__fixtureRuntimeReport is (?:not a function|undefined)$/.test(message) || message === 'fixture-binding-missing') return 'binding-missing';
  if (/Execution context was destroyed|Target page, context or browser has been closed|Target closed|Execution context is not available/.test(message)) return 'context-closed';
  if (message === 'Load failed') return 'load-failed';
  if (message === 'runtime witness missing') return 'witness-missing';
  return 'unclassified';
}

export function retirementFor(failure, lifecycle) {
  if (!failure.generation || !Number.isInteger(failure.requestId) || !failure.frame) return null;
  const sameFrame = event => event.page === failure.page && event.frame === failure.frame;
  const start = lifecycle.find(event => sameFrame(event) && event.kind === 'document-start' && event.generation === failure.generation && event.at <= failure.startedAt);
  if (!start) return null;
  return lifecycle.find(event => sameFrame(event) &&
    (event.kind === 'document-pagehide' && event.generation === failure.generation && event.pendingRequestIds.includes(failure.requestId) ||
      event.kind === 'document-start' && event.generation !== failure.generation && event.at > start.at) &&
    // A later navigation cannot retroactively excuse an already failed fetch.
    failure.startedAt <= event.at && event.at <= failure.at && failure.at - event.at <= 1000 &&
    Math.abs(event.deliveredAt - failure.deliveredAt) <= 1000) || null;
}

export function attributedDiagnostic(error, failures, options, lifecycle = []) {
  if (options.browserName !== 'webkit') return null;
  const url = diagnosticURL(error, options.ownedOrigin, options.apiPaths);
  if (!url || !['empty', 'native-header', 'native-header-with-frames'].includes(diagnosticStackKind(error, url))) return null;
  return failures.find(failure => {
    if (failure.used || failure.page !== error.page || failure.url !== url || failure.method !== 'GET') return false;
    // Native rejection evidence is mandatory even for retirement. PW
    // requestfailed is diagnostic-only, not a second attribution candidate.
    // ThreadableLoader may include fetch-call frames for a CAUGHT rejection;
    // independent ErrorEvent/unhandledrejection witnesses remain the veto.
    return failure.source === 'native-fetch' && failure.documentClass === 'application' && failure.networkFailure && !failure.cancelled &&
      failure.startedAt <= failure.at && Math.abs(failure.at - failure.deliveredAt) <= 1000 &&
      (Boolean(options.origin.failureWindowOverlapping(failure.startedAt, failure.at)?.verifiedUnreachable) || Boolean(retirementFor(failure, lifecycle))) &&
      error.at >= failure.startedAt && Math.abs(error.at - failure.deliveredAt) <= 1000;
  }) || null;
}

export function installRuntimeWitness({ ownedOrigin, apiPaths, fixtureDocumentPaths = [] }) {
  // Popup initial documents can receive the init script twice. Reuse only this
  // actual Document, never a previous document's listeners or fetch wrapper.
  if (window.__fixtureRuntimeWitness?.document === document) return;
  const events = [], pendingReports = new Set(), pendingRequests = new Set();
  const generation = `${Date.now()}:${Math.random()}`;
  Object.defineProperty(window, '__fixtureRuntimeWitness', { value: { document }, configurable: true });
  Object.defineProperty(window, '__fixtureRuntimeEvents', { value: events, configurable: true });
  Object.defineProperty(window, '__fixtureRuntimeFlush', { value: async () => {
    await Promise.all([...pendingReports]);
    return events;
  }, configurable: true });
  const url = new URL(location.href);
  const scope = url.origin === ownedOrigin && fixtureDocumentPaths.includes(url.pathname) && !url.search && !url.hash ? 'fixture-document' : 'application';
  const report = event => {
    const send = async () => {
      // Init scripts and exposed bindings have no guaranteed relative order.
      // Bound the retry; a missing binding is a fatal witness failure, not a
      // reason to ignore page errors. This never delays the app's fetch chain.
      for (let attempt = 0; typeof window.__fixtureRuntimeReport !== 'function' && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      if (typeof window.__fixtureRuntimeReport !== 'function') { events.push('binding-missing'); return; }
      try { await window.__fixtureRuntimeReport({ ...event, generation }); }
      catch (error) {
        events.push(/Execution context was destroyed|Target page, context or browser has been closed|Target closed/.test(error?.message || '') ? 'binding-context-closed' : 'binding-failed');
      }
    };
    const pending = send().finally(() => pendingReports.delete(pending));
    pendingReports.add(pending);
  };
  const runtime = kind => {
    // These are separate original-site fixture documents, not FeedInk code.
    if (scope === 'fixture-document') return;
    events.push(kind);
    report({ kind });
  };
  window.addEventListener('error', event => { if (event instanceof ErrorEvent) runtime('error'); }, true);
  window.addEventListener('unhandledrejection', () => runtime('unhandledrejection'), true);
  window.addEventListener('pagehide', event => {
    if (event.isTrusted) report({ kind: 'document-pagehide', at: Date.now(), pendingRequestIds: [...pendingRequests], runtimeEvents: [...events] });
  }, true);
  report({ kind: 'document-start', at: Date.now() });
  let nextRequestId = 0;
  const nativeFetch = window.fetch;
  window.fetch = function(...args) {
    const startedAt = Date.now();
    // Call first, with the original receiver and arguments. Never replace a
    // native response/rejection or await a reporting binding on the app path.
    const promise = Reflect.apply(nativeFetch, this, args);
    const [input, init] = args;
    // FeedInk's API seam uses string URLs + plain RequestInit data properties.
    // Leave other inputs untouched; do not re-run user coercions/getters.
    let requestURL, signal;
    try {
      if (scope !== 'application' || typeof input !== 'string' || (init != null && Object.getPrototypeOf(init) !== Object.prototype)) return promise;
      const method = init && Object.getOwnPropertyDescriptor(init, 'method');
      signal = init && Object.getOwnPropertyDescriptor(init, 'signal');
      if (method && (!('value' in method) || method.value !== undefined && method.value !== 'GET') || signal && !('value' in signal)) return promise;
      requestURL = new URL(input, location.href);
      if (requestURL.origin !== ownedOrigin || !apiPaths.includes(requestURL.pathname) || requestURL.hash || requestURL.username || requestURL.password) return promise;
    } catch { return promise; }
    const requestId = ++nextRequestId;
    pendingRequests.add(requestId);
    return promise.then(response => { pendingRequests.delete(requestId); return response; }, error => {
      pendingRequests.delete(requestId);
      try {
        report({ kind: 'native-fetch', requestId, url: requestURL.href, method: 'GET', startedAt, at: Date.now(), documentClass: scope,
          networkFailure: error instanceof TypeError && error.message === 'Load failed', cancelled: Boolean(signal?.value?.aborted) });
      } catch {
        // Probe metadata must never replace the original rejected Error.
        events.push('native-probe-failed');
        report({ kind: 'native-probe-failed' });
      }
      // Return this chain to the caller. A handled rejection stays handled;
      // an unhandled rejection still triggers the independent witness.
      throw error;
    });
  };
}

export async function fixturePageErrors(context, options) {
  const errors = [], failures = [], runtimeEvents = [], lifecycle = [];
  const requests = new WeakMap();
  await context.exposeBinding('__fixtureRuntimeReport', (source, event) => {
    const received = { ...event, page: source.page, frame: source.frame, deliveredAt: Date.now() };
    if (event.kind === 'native-fetch') failures.push({ ...received, source: 'native-fetch', used: false });
    else if (event.kind === 'document-start' || event.kind === 'document-pagehide') {
      lifecycle.push(received);
      if (event.kind === 'document-pagehide') runtimeEvents.push(...event.runtimeEvents);
    } else runtimeEvents.push(event.kind);
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
        // Flush reports before asserting so a binding promise cannot race the
        // final assertion. Missing/destroyed witnesses stay fatal, code-only.
        try {
          currentEvents.push(...await page.evaluate(async () => {
            if (!Array.isArray(window.__fixtureRuntimeEvents) || typeof window.__fixtureRuntimeFlush !== 'function') throw new Error('runtime witness missing');
            return window.__fixtureRuntimeFlush();
          }));
        } catch (error) { currentEvents.push(safeFailureKind(error)); }
      }
      assert.deepEqual([...runtimeEvents, ...currentEvents], [], 'Independent ErrorEvent/unhandledrejection witness');
      const unexpected = [];
      let outageAttributed = 0, retirementAttributed = 0;
      for (const error of errors) {
        if (error.sourceClass === 'fixture-document') continue;
        const failure = attributedDiagnostic(error, failures, options, lifecycle);
        if (failure) {
          failure.used = true;
          if (options.origin.failureWindowOverlapping(failure.startedAt, failure.at)?.verifiedUnreachable) outageAttributed++;
          else retirementAttributed++;
          continue;
        }
        const url = diagnosticURL(error, options.ownedOrigin, options.apiPaths);
        // Finite categories only: no URLs, exception text, bodies or raw stacks.
        unexpected.push({ errorName: ['Error', 'TypeError', 'ReferenceError', 'SecurityError', 'SyntaxError', 'AbortError', 'Fetch API cannot load http'].includes(error.name) ? error.name : 'other',
          failureKind: safeFailureKind(error),
          witnessCodeFrame: /\b(?:installRuntimeWitness|__fixtureRuntimeReport|__fixtureRuntimeEvents)\b/.test(error.stack || ''),
          sourceClass: error.sourceClass, frameClass: error.frameClass, pageClass: documentClass(error.page?.url(), options),
          knownFetchShape: Boolean(url), stackKind: diagnosticStackKind(error, url),
          fetchSuffix: error.message?.endsWith(' due to access control checks.') === true,
          pausedOrigin: Boolean(options.origin.failureWindowAt(error.at)?.verifiedUnreachable),
          failedFetchCount: failures.filter(item => item.resourceType === 'fetch').length,
          nativeFailureCount: failures.filter(item => item.source === 'native-fetch').length,
          matchingURLFailureCount: failures.filter(item => item.page === error.page && item.url === url).length,
          matchingNetworkFailureCount: failures.filter(item => item.source === 'native-fetch' && item.page === error.page && item.url === url && item.networkFailure && !item.cancelled).length,
          overlappingNativeFailureCount: failures.filter(item => item.source === 'native-fetch' && options.origin.failureWindowOverlapping(item.startedAt, item.at)?.verifiedUnreachable).length,
          matchingRetiredNativeFailureCount: failures.filter(item => item.source === 'native-fetch' && item.page === error.page && item.url === url && retirementFor(item, lifecycle)).length,
          // Diagnose ordering without treating a later navigation as causation.
          matchingLaterPagehideFailureCount: failures.filter(item => item.source === 'native-fetch' && item.page === error.page && item.url === url && lifecycle.some(event =>
            event.kind === 'document-pagehide' && event.page === item.page && event.frame === item.frame && event.generation === item.generation && event.at > item.at && event.at - item.at <= 1000)).length,
          documentStartCount: lifecycle.filter(item => item.page === error.page && item.kind === 'document-start').length,
          documentPagehideCount: lifecycle.filter(item => item.page === error.page && item.kind === 'document-pagehide').length });
      }
      assert.deepEqual(unexpected, [], 'Unexpected pageerror (safe diagnostic metadata)');
      if (outageAttributed || retirementAttributed) console.log(`Attributed native WebKit fetch diagnostics: verified TCP outage=${outageAttributed}, witnessed document retirement=${retirementAttributed}; runtime witnesses clean.`);
    },
  };
}

// Real browser sensitivity, on a separate non-application page: neither a throw
// nor an unhandled rejection may disappear, even with the native diagnostic text.
export async function verifyRuntimeErrorWitness(browser) {
  for (const mode of ['plain-throw', 'plain-unhandled', 'lookalike-throw', 'lookalike-unhandled', 'native-fetch-unhandled']) {
    const context = await browser.newContext();
    try {
      const options = { browserName: 'webkit', ownedOrigin: 'http://127.0.0.1:1', apiPaths: ['/api/session'], origin: { failureWindowAt: () => null, failureWindowOverlapping: () => null } };
      const witness = await fixturePageErrors(context, options);
      // Exercise duplicate installation in a real browser, including reload.
      await context.addInitScript(installRuntimeWitness, { ownedOrigin: options.ownedOrigin, apiPaths: options.apiPaths });
      const page = await context.newPage();
      await page.goto('data:text/html,<title>Runtime witness sensitivity</title>');
      await witness.assertClean();
      await page.evaluate(mode => {
        const error = () => mode.startsWith('lookalike')
          ? Object.assign(new Error('/127.0.0.1:1/api/session due to access control checks.'), {
            name: 'Fetch API cannot load http',
            stack: 'Fetch API cannot load http://127.0.0.1:1/api/session due to access control checks.\n    at fetch (http://127.0.0.1:1/assets/app.js:1:2)',
          })
          : new Error('fixture runtime failure');
        if (mode.endsWith('-throw')) setTimeout(() => { throw error(); }, 0);
        else if (mode === 'native-fetch-unhandled') void fetch('http://127.0.0.1:1/api/session');
        else void Promise.reject(error());
      }, mode);
      const kind = mode.endsWith('-throw') ? 'error' : 'unhandledrejection';
      await page.waitForFunction(kind => window.__fixtureRuntimeEvents.includes(kind), kind);
      // Each mode has just ONE independent fault: an unrelated throw cannot
      // accidentally make a broken unhandled-fetch witness appear sensitive.
      await page.evaluate(() => window.__fixtureRuntimeFlush());
      await page.reload();
      await assert.rejects(() => witness.assertClean(), /Independent ErrorEvent\/unhandledrejection witness/);
    } finally { await context.close(); }
  }
}
