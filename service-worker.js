const CACHE_NAME = 'stroll-v1';

// Install: Cache app shell
self.addEventListener('install', (event) => {
  console.log('✅ Service Worker installing');
  self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker activating');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch: Try cache first, fallback to network
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip API calls - let them go to network
  if (url.pathname.includes('/netlify/') || 
      url.hostname.includes('router.project-osrm') ||
      url.hostname.includes('nominatim')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
      .catch(() => caches.match('/'))
  );
});
