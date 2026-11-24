/*
 * Service Worker v6
 *
 * 舊版 (sw.js / sw-v4 / sw-v5) 對「所有」同源 GET 都用 cache-first，
 * 包含 index.html。結果是：即使部署了新版本，使用者的手機仍然一直執行舊的
 * index.html（而且舊版 sw 會 skipWaiting + clients.claim，讓問題更難察覺）。
 *
 * 這裡改成：
 *  - App shell / JS 模組：network-first（最多等 3 秒）→ 失敗才用快取
 *  - vendor 函式庫：cache-first（很少變動）
 *  - 導覽請求：network-first，離線時回 index.html
 *  - /api/*、非 GET、Range 請求：完全不攔截
 */

const VERSION = 'v15';
const CACHE = `product-label-app-${VERSION}`;
const NETWORK_TIMEOUT = 3000;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/core/text.js',
  './js/core/matcher.js',
  './js/core/match.worker.js',
  './js/core/hash.js',
  './js/core/queue.js',
  './js/core/pipeline.js',
  './js/store/db.js',
  './js/store/api.js',
  './js/ui/jobs-view.js'
];

const VENDOR = [
  './vendor/xlsx.full.min.js',
  './vendor/html5-qrcode.min.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([...SHELL, ...VENDOR].map(async url => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        // 單一檔案失敗不要讓整個安裝失敗
        console.warn('[sw] precache 失敗', url, err && err.message);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('離線中，且此資源尚未快取', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  if (url.pathname.includes('/vendor/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (/\.(?:html|js|mjs|json|webmanifest)$/.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
