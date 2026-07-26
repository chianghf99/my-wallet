/**
 * 報價代理 Worker（stock-proxy）
 *
 * 這支 Worker 的用途是繞過瀏覽器的 CORS 限制，讓前端能取得台股與美股報價。
 *
 * ⚠️ 舊版是「?url= 後面接什麼就轉什麼」的開放代理：任何人只要知道這個網址，
 * 就能拿它去代理任意網站，消耗你的 Cloudflare 額度，也可能讓你的 Worker
 * 被當成攻擊來源。這一版加上網域白名單，只允許報價來源。
 *
 * 部署方式：Cloudflare Dashboard → Workers & Pages → 選 stock-proxy
 *          → Edit code → 全選貼上這份內容 → Deploy
 */

// 只有這些主機可以被代理。新增報價來源時要同步加進來，否則前端會收到 403。
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'mis.twse.com.tw',
  'openapi.twse.com.tw',
  'www.tpex.org.tw',
  'ws.api.cnyes.com'
]);

// 只允許自己的網站呼叫。留空陣列則不限制來源（除錯時才這樣做）。
const ALLOWED_ORIGINS = [
  'https://chianghf99.github.io',
  'http://localhost:8899'
];

const corsHeaders = (origin) => {
  const allow = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allow ? (origin || '*') : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
};

const deny = (status, message, origin) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return deny(405, 'Method not allowed', origin);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return deny(400, 'Missing url parameter', origin);

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return deny(400, 'Invalid url parameter', origin);
    }

    // 只放行 https，避免被當成明文流量的跳板
    if (targetUrl.protocol !== 'https:') {
      return deny(400, 'Only https is allowed', origin);
    }
    // 白名單比對整個主機名稱，不能用 endsWith
    //（否則 evil-mis.twse.com.tw.attacker.com 之類的網域會被誤放行）
    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return deny(403, `Host not allowed: ${targetUrl.hostname}`, origin);
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          // 部分來源會擋沒有 User-Agent 的請求
          'User-Agent': 'Mozilla/5.0 (compatible; stock-proxy)',
          'Accept': 'application/json, text/plain, */*',
          // MIS 需要 Referer 才會正常回應
          ...(targetUrl.hostname === 'mis.twse.com.tw'
            ? { Referer: 'https://mis.twse.com.tw/stock/index.jsp' }
            : {})
        },
        // 報價要即時，不要讓 Cloudflare 邊緣快取
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
          ...corsHeaders(origin)
        }
      });
    } catch (err) {
      return deny(502, `Upstream fetch failed: ${err.message}`, origin);
    }
  }
};
