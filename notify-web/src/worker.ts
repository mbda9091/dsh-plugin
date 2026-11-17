/** Standalone classic worker, served by the Host without bundler/runtime imports.
 * It owns only notifications: no fetch interception, caches or background SSE.
 */
export const notificationWorker = String.raw`
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
let opening = Promise.resolve();
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data;
  if (!data || typeof data.sessionId !== 'string' || typeof data.id !== 'string') return;
  // Derive the app URL from our own script, never from notification input.
  const base = new URL('../../', self.location.href);
  const url = new URL(base);
  url.searchParams.set('notify-web-session', data.sessionId);
  url.searchParams.set('notify-web-id', data.id);
  opening = opening.catch(() => {}).then(async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== base.origin || !current.pathname.startsWith(base.pathname)
          || current.pathname.startsWith(new URL('api/', base).pathname)) continue;
      try {
        await client.focus();
        const acknowledged = await new Promise(resolve => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1500);
          channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(true); };
          client.postMessage({ type: 'notify-web:open', id: data.id, sessionId: data.sessionId }, [channel.port2]);
        });
        if (!acknowledged) await client.navigate(url.href);
        return;
      } catch { /* A closing tab can disappear between matchAll and focus. */ }
    }
    await self.clients.openWindow(url.href);
  });
  event.waitUntil(opening);
});
`;
