// Willy's Task service worker — notifications only, no caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) { if ("focus" in client) return client.focus(); }
      return self.clients.openWindow("./");
    })
  );
});
