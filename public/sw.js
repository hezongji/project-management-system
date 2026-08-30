// 自卸载 SW：清空所有历史缓存并注销自身（修复旧版 cache-first 缓存导致部署后页面无数据）
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
      await self.registration.unregister();
    })()
  );
});
