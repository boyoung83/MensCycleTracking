// Service worker: 네트워크 우선(온라인이면 항상 최신), 오프라인이면 캐시 사용.
// 캐시 버전을 올리면 기존 캐시를 정리하고 새로 받는다.
const CACHE = 'cycle-tracker-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 구글 API/인증은 절대 캐시하지 않음.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return;
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 네트워크 우선: 최신을 받아 캐시에 갱신, 실패하면 캐시로 폴백(오프라인).
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
  );
});

// 페이지에서 알림을 요청하면 SW가 표시(설치 상태에서 동작).
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'notify') {
    self.registration.showNotification(d.title || '생리주기 알림', {
      body: d.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: d.tag || 'cycle',
      renotify: true,
    });
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  }));
});
