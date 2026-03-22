// v2-app/sw.js
// 职责：Service Worker，离线缓存策略
// 策略：
//   - App Shell (HTML/JS/CSS)：Cache First，后台更新
//   - API 请求（Worker / Firestore）：Network First，失败降级到缓存
//   - 图片（Firebase Storage）：Cache First，过期后重新获取

const CACHE_VERSION   = "duka-v2-v1";
const SHELL_CACHE     = `${CACHE_VERSION}-shell`;
const IMG_CACHE       = `${CACHE_VERSION}-images`;
const API_CACHE       = `${CACHE_VERSION}-api`;

// App Shell 资源（安装时预缓存）
const SHELL_URLS = [
  "/",
  "/index.html",
  "/js/core-config.js",
  "/js/api-bridge.js",
  "/js/ui-layout.js",
  "/js/feature-logic.js",
  "/js/match-engine.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ── 安装：预缓存 App Shell ────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(SHELL_URLS).catch((err) => {
        console.warn("[SW] 部分 Shell 资源缓存失败：", err);
      });
    })
  );
  // 立即激活，不等待旧 SW 退出
  self.skipWaiting();
});

// ── 激活：清理旧版本缓存 ──────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("duka-v2-") && !key.startsWith(CACHE_VERSION))
          .map((key) => {
            console.log("[SW] 清理旧缓存：", key);
            return caches.delete(key);
          })
      )
    )
  );
  // 立即接管所有已打开的页面
  self.clients.claim();
});

// ── 拦截请求 ──────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 非 GET 请求（POST 等）不走缓存
  if (request.method !== "GET") return;

  // Firebase / Worker API 请求：Network First
  if (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("cloudfunctions.net")       ||
    url.hostname.includes("yourdomain.com")            ||  // Cloudflare Worker 域名
    url.pathname.startsWith("/api/")
  ) {
    event.respondWith(networkFirst(request, API_CACHE, 10_000));
    return;
  }

  // Firebase Storage 图片：Cache First（图片不常变）
  if (
    url.hostname.includes("storage.googleapis.com") ||
    url.hostname.includes("firebasestorage.googleapis.com")
  ) {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  // App Shell（JS / HTML / CSS / 图标）：Cache First + 后台更新
  if (
    url.pathname.endsWith(".js")   ||
    url.pathname.endsWith(".css")  ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".png")  ||
    url.pathname.endsWith(".svg")  ||
    url.pathname === "/"
  ) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // 其他请求：直接走网络
});

// ── 缓存策略实现 ──────────────────────────────────────

/**
 * Network First：先尝试网络，失败或超时则降级到缓存
 */
async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);

  const networkPromise = fetch(request.clone()).then((resp) => {
    if (resp.ok) {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  });

  // 超时降级
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Network timeout")), timeoutMs)
  );

  try {
    return await Promise.race([networkPromise, timeoutPromise]);
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // 离线且无缓存：返回离线提示
    return offlineResponse(request);
  }
}

/**
 * Cache First：先查缓存，缓存未命中再走网络
 */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const resp = await fetch(request);
    if (resp.ok) cache.put(request, resp.clone()).catch(() => {});
    return resp;
  } catch {
    return offlineResponse(request);
  }
}

/**
 * Stale While Revalidate：返回缓存同时后台更新
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  // 后台发起网络请求更新缓存
  const networkFetch = fetch(request).then((resp) => {
    if (resp.ok) cache.put(request, resp.clone()).catch(() => {});
    return resp;
  }).catch(() => null);

  return cached || await networkFetch || offlineResponse(request);
}

/**
 * 离线降级响应
 */
function offlineResponse(request) {
  const url = new URL(request.url);

  // HTML 页面降级到 App Shell
  if (request.headers.get("accept")?.includes("text/html")) {
    return caches.match("/index.html").then(
      (cached) => cached || new Response("离线中，请检查网络连接", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }

  // API 请求降级到离线 JSON
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("firestore.googleapis.com")
  ) {
    return new Response(
      JSON.stringify({ ok: false, error: "离线中，数据将在恢复联网后同步", offline: true }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("资源不可用（离线）", { status: 503 });
}

// ── 后台同步（离线录入时推送到 IndexedDB，联网后自动上报）
// 需配合前端 api-bridge.js 的离线队列实现，此处注册监听

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-transactions") {
    event.waitUntil(syncPendingTransactions());
  }
});

async function syncPendingTransactions() {
  // 通知所有客户端执行同步
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => {
    client.postMessage({ type: "SYNC_PENDING_TRANSACTIONS" });
  });
}
