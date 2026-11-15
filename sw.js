const CACHE_NAME = 'ma-wabi-sabi-agenda-v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/wabi-sabi.css',
  './js/config.js',
  './js/db.js',
  './js/ai-pipeline.js',
  './js/app.js',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Recebe notificações Web Push enviadas pela Edge Function do Supabase quando um bloco termina
self.addEventListener('push', (event) => {
  let payload = {
    title: 'bloco concluído',
    body: 'toque para avaliar de 0 a 5 estrelas',
    blockId: null
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch (e) {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icons/icon.svg',
      badge: './icons/icon.svg',
      tag: payload.blockId ? `rate-${payload.blockId}` : 'block-rating',
      data: { blockId: payload.blockId }
    })
  );
});

// Ao clicar na notificação no telemóvel, abre a app diretamente no ecrã de avaliação desse bloco
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const blockId = event.notification?.data?.blockId;
  const targetUrl = blockId ? `./index.html#rate=${encodeURIComponent(blockId)}` : './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (blockId) {
            client.postMessage({ type: 'OPEN_RATING_SHEET', blockId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
