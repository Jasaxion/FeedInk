import assert from 'node:assert/strict';
import { createConnection } from 'node:net';

// Stop only the test-owned listener. Unlike WebKit protocol offline emulation,
// this leaves service workers, IndexedDB and data/blob URLs on their real paths.
export function fixtureOrigin(server) {
  const port = server.address().port;
  const failureWindows = [];
  const pauseOrigin = async () => {
    if (!server.listening) return;
    const window = { id: failureWindows.length, startedAt: Date.now(), endedAt: null, verifiedUnreachable: false };
    failureWindows.push(window);
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    // Independent transport witness: the owned port must refuse a real TCP
    // connection, not merely dispatch an offline event or fail a routed fetch.
    const result = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const finish = result => { socket.destroy(); resolve(result); };
      socket.once('connect', () => finish('connected'));
      socket.once('error', error => finish(error.code));
      socket.setTimeout(2000, () => finish('timeout'));
    });
    assert.equal(result, 'ECONNREFUSED', 'Paused fixture origin must be unreachable');
    window.verifiedUnreachable = true;
  };
  const resumeOrigin = async () => {
    if (server.listening) return;
    const window = failureWindows.at(-1);
    if (window) window.endedAt = Date.now();
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
    });
  };
  const failureWindowAt = at => failureWindows.find(window => at >= window.startedAt && (window.endedAt === null || at < window.endedAt));
  const failureWindowOverlapping = (startedAt, endedAt) => {
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
    return failureWindows.find(window => window.verifiedUnreachable && endedAt >= window.startedAt && (window.endedAt === null || startedAt < window.endedAt)) || null;
  };
  return { pauseOrigin, resumeOrigin, failureWindowAt, failureWindowOverlapping };
}

export function fixtureOffline(context, origin) {
  return async offline => {
    if (process.env.FEEDINK_BROWSER !== 'webkit') return context.setOffline(offline);
    if (offline) await origin.pauseOrigin(); else await origin.resumeOrigin();
    // Listener shutdown supplies the network failure; this supplies the browser
    // connectivity notification for tests that stay in the current document.
    for (const page of context.pages()) await page.evaluate(offline => window.dispatchEvent(new Event(offline ? 'offline' : 'online')), offline);
  };
}
