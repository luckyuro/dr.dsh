const offlineSessions = new WeakMap();
export const OFFLINE_PROBE_PATH = '/__dr/control/offline-probe';

/** Load a cached document with transport blocked and the offline browser indicator set. */
export async function reloadOffline(context, page) {
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  // Chromium 149/151 resets navigator.onLine on navigation even while Playwright keeps
  // requests blocked. Verify the transport first, then restore the DevTools indicator;
  // otherwise a test of the page's offline message only tests that emulator regression.
  const session = await context.newCDPSession(page);
  offlineSessions.set(page, session);
  await session.send('Network.enable');
  // This reserved path passes through the worker without caching or tunnelling.
  // Globally bypassing the worker here can break the shell's pending dynamic imports.
  const blocked = await page.evaluate(async path => {
    try { await fetch(path, { cache: 'no-store' }); return false; }
    catch { return true; }
  }, OFFLINE_PROBE_PATH);
  if (!blocked) throw new Error('The offline navigation did not keep uncached network requests blocked.');
  if (await page.evaluate(() => navigator.onLine)) {
    await session.send('Network.overrideNetworkState', {
      offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  }
}

export async function restoreOnline(context, page) {
  // Detaching a DevTools session also resets its network indicator. Keep it alive
  // throughout the offline assertions, then let Playwright restore both settings.
  await offlineSessions.get(page)?.detach();
  offlineSessions.delete(page);
  await context.setOffline(false);
}
