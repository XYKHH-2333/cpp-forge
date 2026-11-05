/* Service Worker：把整个应用外壳缓存下来。
 *
 * 为什么必须有它：
 *   1) 装到桌面（PWA）需要 SW；
 *   2) 更重要的——**缓存之后即使托管它的那台机器/容器没了，
 *      桌面图标照样能打开**，界面和数据（localStorage）都还在，
 *      生成代码走的是直连 API，不依赖这个服务器。
 *
 * 策略：外壳用 cache-first（秒开、离线可用），请求失败时回退到缓存；
 *       版本号变了会在下次打开时更新。
 */
const CACHE = 'cpp-forge-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const BUILD='2026-11-05.2';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只接管同源静态资源；API 请求（跨域）一律放行，不缓存。
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // 后台顺带更新一份，下次打开就是新的
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
