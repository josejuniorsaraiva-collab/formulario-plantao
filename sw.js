/* ============================================================
   NEUROAUTH — Service Worker
   Estratégia: Cache-first com network fallback
   Otimizado para ambiente hospitalar (internet instável)
   ============================================================ */

const APP_VERSION = 'neuroauth-v2.1';
const CACHE_NAME  = `${APP_VERSION}-cache`;

// Recursos que DEVEM estar disponíveis offline
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
];

/* ──────────────────────────────────────────────
   INSTALL — pré-cache de recursos críticos
────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pré-cacheando recursos críticos');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting()) // Ativa imediatamente sem esperar reload
  );
});

/* ──────────────────────────────────────────────
   ACTIVATE — limpa caches antigos
────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Removendo cache antigo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim()) // Assume controle imediato de todas as abas
  );
});

/* ──────────────────────────────────────────────
   FETCH — estratégia para ambiente hospitalar

   Para o formulário (HTML): Cache-first + revalidação em background
   Para o webhook (Make.com): Network-only com fila offline
   Para outros: Stale-while-revalidate
────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // WEBHOOK Make.com — sempre tenta network; se falhar, enfileira
  if (url.hostname.includes('make.com') || url.hostname.includes('hook.')) {
    event.respondWith(networkWithQueueFallback(event.request));
    return;
  }

  // Recursos externos (fonts, CDNs) — network-first com cache fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirstWithCache(event.request));
    return;
  }

  // Recursos locais (HTML, CSS, JS, icons) — cache-first com revalidação
  event.respondWith(cacheFirstWithRevalidate(event.request));
});

/* ──────────────────────────────────────────────
   ESTRATÉGIAS DE CACHE
────────────────────────────────────────────── */

// Cache-first: retorna do cache instantaneamente; atualiza em background
async function cacheFirstWithRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Dispara atualização em background sem bloquear
  const networkFetch = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Retorna cache imediatamente se disponível (para velocidade em plantão)
  if (cached) {
    return cached;
  }

  // Se não tem cache, espera a rede
  return networkFetch || new Response('Offline — recurso não disponível', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// Network-first: tenta rede primeiro, fallback para cache
async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(4000) });
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response('', { status: 408 });
  }
}

/* ──────────────────────────────────────────────
   FILA OFFLINE PARA WEBHOOK

   Quando o Make.com não está acessível (rede hospitalar instável),
   salva o payload em IndexedDB e reenvía quando a conexão voltar.
────────────────────────────────────────────── */
const QUEUE_DB = 'neuroauth-offline-queue';
const QUEUE_STORE = 'pending-requests';

async function networkWithQueueFallback(request) {
  try {
    const response = await fetch(request.clone(), { signal: AbortSignal.timeout(8000) });
    return response;
  } catch (err) {
    // Falha de rede — salva na fila offline
    const body = await request.text();
    await saveToOfflineQueue({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
      timestamp: Date.now()
    });

    // Notifica a UI
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({
      type: 'OFFLINE_QUEUED',
      message: 'Sem conexão. Solicitação salva e será enviada automaticamente quando a rede voltar.'
    }));

    // Retorna resposta simulada para não quebrar o fluxo da UI
    return new Response(JSON.stringify({
      status: 'queued',
      message: 'Offline — enviado para fila'
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function saveToOfflineQueue(item) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(QUEUE_STORE, { autoIncrement: true });
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction(QUEUE_STORE, 'readwrite');
      tx.objectStore(QUEUE_STORE).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/* ──────────────────────────────────────────────
   SYNC — reenvio automático quando rede volta
────────────────────────────────────────────── */
self.addEventListener('sync', event => {
  if (event.tag === 'neuroauth-sync') {
    event.waitUntil(flushOfflineQueue());
  }
});

async function flushOfflineQueue() {
  return new Promise((resolve) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction(QUEUE_STORE, 'readwrite');
      const store = tx.objectStore(QUEUE_STORE);
      const getAll = store.getAll();
      const getAllKeys = store.getAllKeys();

      Promise.all([
        new Promise(r => { getAll.onsuccess = () => r(getAll.result); }),
        new Promise(r => { getAllKeys.onsuccess = () => r(getAllKeys.result); })
      ]).then(([items, keys]) => {
        const sends = items.map((item, i) =>
          fetch(item.url, {
            method: item.method,
            headers: item.headers,
            body: item.body
          }).then(() => {
            // Remove da fila após sucesso
            const delTx = db.transaction(QUEUE_STORE, 'readwrite');
            delTx.objectStore(QUEUE_STORE).delete(keys[i]);
          }).catch(() => {}) // Mantém na fila se ainda falhar
        );
        Promise.all(sends).then(resolve);
      });
    };
    req.onerror = () => resolve();
  });
}

/* ──────────────────────────────────────────────
   MESSAGES — comunicação com a UI
────────────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});

console.log('[SW] NEUROAUTH Service Worker carregado —', APP_VERSION);
