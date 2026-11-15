// Stop only the test-owned listener. Unlike WebKit protocol offline emulation,
// this leaves service workers, IndexedDB and data/blob URLs on their real paths.
export function fixtureOrigin(server) {
  const port = server.address().port;
  const pauseOrigin = async () => {
    if (!server.listening) return;
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  };
  const resumeOrigin = async () => {
    if (server.listening) return;
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
    });
  };
  return { pauseOrigin, resumeOrigin };
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
