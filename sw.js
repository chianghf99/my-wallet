// Service Worker —— 讓網頁可以「加到主畫面」並在離線時仍開得起來。
//
// 設計原則：這是記帳／資產工具，顯示過期的數字比顯示不了更糟，因此：
//   1. 自家檔案一律「網路優先」，只有在斷線時才拿快取墊檔 —— 線上時永遠是最新程式碼。
//   2. Firebase / Firestore / 報價 API 完全不攔截，交給瀏覽器原生處理
//      （Firestore 走長輪詢與串流，攔截會出問題）。
//   3. CDN 函式庫（Vue、Tailwind、Chart.js…）版本固定，用快取優先並在背景更新。
//
// 要停用這個 Service Worker：把 KILL_SWITCH 改成 true 並部署一次，
// 它會自我登出並清掉所有快取，使用者重新整理後就回到沒有 SW 的狀態。

const KILL_SWITCH = false;

const VERSION = 'v1';
const SHELL_CACHE = `mywallet-shell-${VERSION}`;
const CDN_CACHE = `mywallet-cdn-${VERSION}`;

// 離線時至少要能開起來的檔案
const SHELL_ASSETS = [
    './',
    './index.html',
    './mystock.html',
    './mycreditcard.html',
    './js/main.js',
    './js/store/index.js',
    './js/utils/format.js',
    './js/firebase-config.js',
    './manifest.webmanifest',
    './manifest-stock.webmanifest',
    './manifest-card.webmanifest',
    './icons/hub/icon-192.png',
    './icons/hub/apple-touch-icon.png',
    './icons/stock/icon-192.png',
    './icons/stock/apple-touch-icon.png',
    './icons/card/icon-192.png',
    './icons/card/apple-touch-icon.png'
];

// 這些主機的資源版本固定，可以放心長期快取
const CDN_HOSTS = new Set([
    'unpkg.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
]);

// 這些絕對不能碰：即時報價與資料庫連線
const NEVER_HANDLE = [
    'firestore.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'www.googleapis.com',
    'apis.google.com',
    'accounts.google.com',
    'finnhub.io',
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com',
    'api.exchangerate-api.com',
    'ws.api.cnyes.com',
    'mis.twse.com.tw',
    'openapi.twse.com.tw',
    'www.tpex.org.tw'
];

self.addEventListener('install', (event) => {
    if (KILL_SWITCH) return;
    event.waitUntil(
        caches.open(SHELL_CACHE)
            // 個別檔案抓不到不該讓整個安裝失敗
            .then(cache => Promise.allSettled(SHELL_ASSETS.map(u => cache.add(u))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        if (KILL_SWITCH) {
            const names = await caches.keys();
            await Promise.all(names.map(n => caches.delete(n)));
            await self.registration.unregister();
            return;
        }
        // 清掉舊版本的快取
        const names = await caches.keys();
        await Promise.all(
            names.filter(n => n.startsWith('mywallet-') && n !== SHELL_CACHE && n !== CDN_CACHE)
                 .map(n => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    if (KILL_SWITCH) return;

    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (!url.protocol.startsWith('http')) return;
    if (NEVER_HANDLE.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;
    // 自架的報價代理也不要攔（每次都要最新價格）
    if (url.hostname.endsWith('.workers.dev')) return;

    if (url.origin === self.location.origin) {
        // 自家檔案：網路優先，斷線才用快取
        event.respondWith((async () => {
            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok) {
                    const cache = await caches.open(SHELL_CACHE);
                    cache.put(req, fresh.clone());
                }
                return fresh;
            } catch (e) {
                const cached = await caches.match(req);
                if (cached) return cached;
                // 導覽請求離線時退回首頁，避免出現瀏覽器的恐龍頁面
                if (req.mode === 'navigate') {
                    const fallback = await caches.match('./index.html');
                    if (fallback) return fallback;
                }
                throw e;
            }
        })());
        return;
    }

    if (CDN_HOSTS.has(url.hostname)) {
        // CDN 函式庫：快取優先，同時在背景抓新版備用
        event.respondWith((async () => {
            const cached = await caches.match(req);
            const network = fetch(req).then(resp => {
                if (resp && (resp.ok || resp.type === 'opaque')) {
                    caches.open(CDN_CACHE).then(c => c.put(req, resp.clone()));
                }
                return resp;
            }).catch(() => null);
            return cached || (await network) || Response.error();
        })());
    }
});
