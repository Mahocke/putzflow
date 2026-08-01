// sw.js — Service Worker.
//
// ⚠️ Lehre aus Glanz & Gloria (2026-06-18): eine gecachte Start-HTML friert
// iOS-„Zum Home-Bildschirm"-Apps monatelang auf einem alten Stand ein. Deshalb:
// HTML und /api/* IMMER aus dem Netz, nur statische Assets aus dem Cache.

const CACHE = 'putzflow-v1';
const ASSETS = ['/style.css', '/app.js', '/m.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHtml = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHtml || url.pathname.startsWith('/api/')) return;      // immer Netz, nie Cache

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
});
