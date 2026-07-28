// 每日資產快照（排程版）
//
// 目的：前端的 saveDailySnapshot 只有「開網頁」時才會跑，沒開的日子走勢圖就會有洞，
// 每月統計也會拿更早的一筆頂上導致數字偏掉。這支腳本由 GitHub Actions 每個交易日
// 14:30（台北）觸發，抓完當日收盤價後直接寫入 history/{date}。
//
// 估值邏輯與前端共用 js/utils/valuation.js，不再各寫一份 —— 只改一邊會讓排程
// 默默寫入用舊公式算出的歷史紀錄，而且不會有任何錯誤訊息。
//
// 需要的環境變數：
//   FIREBASE_SERVICE_ACCOUNT  Firebase 服務帳戶金鑰 JSON（整份貼上）
//   FINNHUB_API_KEY           選填。美股的備援報價來源；主要來源是 Yahoo，不需金鑰
//   APP_UID                   要快照的帳號 uid，多組以逗號分隔（必填）
//   SNAPSHOT_ALL_USERS        設為 'true' 才會處理專案下所有帳號（沒有 APP_UID 時的明確開關）
//
// ⚠️ 這個 repo 是公開的，GitHub Actions 的執行日誌任何人都看得到（不需登入）。
// 因此日誌只能印筆數與狀態，絕對不要印出 uid、金額、持股代號等可識別或敏感的內容。

import admin from 'firebase-admin';
// 與前端共用同一份估值邏輯，避免兩邊公式走鐘（見 js/utils/valuation.js）
import { buildSnapshotFields } from '../js/utils/valuation.js';
// 期貨取價的挑選邏輯也與前端共用（日夜盤、週契約、月份對應都在這裡）
import { TAIFEX_PRODUCTS, TAIFEX_MIS_URL, taifexRequestBody, contractMonthOf,
         pickContract, pickDaySessionFirst, pickFromOpenData, OPEN_DATA_CONTRACT } from '../js/utils/futures.js';

const TZ = 'Asia/Taipei';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- 基礎工具 ---

const getTaipeiDate = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

const getTaipeiHour = () => Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false
}).format(new Date()));

const sleep = ms => new Promise(r => setTimeout(r, ms));

const fetchJson = async (url, { retry = 1, timeoutMs = 10000, headers = {} } = {}) => {
    let lastErr;
    for (let i = 0; i <= retry; i++) {
        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), timeoutMs);
            // Yahoo 等服務會擋沒有 User-Agent 的請求
            const resp = await fetch(url, {
                signal: ctrl.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (mywallet-snapshot)', ...headers }
            });
            clearTimeout(tid);
            if (!resp.ok) {
                const err = new Error(`HTTP ${resp.status}`);
                err.status = resp.status;
                throw err;
            }
            return await resp.json();
        } catch (e) {
            lastErr = e;
            if (i >= retry) throw e;
            // 429 是額度用完，等久一點才有意義；一般錯誤退避即可
            await sleep(e.status === 429 ? 15000 : (i + 1) * 800);
        }
    }
    throw lastErr;
};

const isTwSymbol = sym => /^\d{4,6}[A-Z]?$/.test(sym) || /\.(TW|TWO)$/i.test(sym);

// --- 報價來源 ---

// 匯率。抓不到就整支中止：用預設值算出來的淨值寫進 history 會永久污染走勢圖。
const fetchExchangeRate = async () => {
    const d = await fetchJson('https://api.exchangerate-api.com/v4/latest/USD', { retry: 2 });
    const rate = d?.rates?.TWD;
    if (!(rate > 0)) throw new Error('匯率回應格式不正確');
    return rate;
};

// Yahoo v8 chart 的共用查詢。台股與美股都走這裡。
// 注意 previousClose 實測可能是 null，一定要有 chartPreviousClose 退路，
// 否則昨收會等於現價，整份漲跌幅都變成 0%。
const fetchYahooQuote = async (yahooSymbol) => {
    try {
        const j = await fetchJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`);
        const meta = j?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice > 0) {
            return {
                price: meta.regularMarketPrice,
                prevClose: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice
            };
        }
    } catch (e) { /* 由呼叫端決定退路 */ }
    return null;
};

// 台股第一層：Yahoo。marketType 決定先試 .TW 還是 .TWO，失敗再換另一個。
const fetchTwPriceYahoo = async (stock) => {
    const clean = stock.symbol.replace(/\.(TW|TWO)$/i, '');
    const first = (stock.marketType === 'otc' || stock.marketType === 'esb') ? '.TWO' : '.TW';
    for (const suffix of [first, first === '.TWO' ? '.TW' : '.TWO']) {
        const q = await fetchYahooQuote(`${clean}${suffix}`);
        if (q) return q;
    }
    return null;
};

// 台股第二層：證交所 MIS 即時報價。Yahoo 查不到的（興櫃、新上市）這裡通常有。
const fetchTwPriceMis = async (stock) => {
    const clean = stock.symbol.replace(/\.(TW|TWO)$/i, '');
    const markets = stock.marketType === 'otc' ? ['otc', 'tse'] : ['tse', 'otc'];
    const exCh = markets.map(m => `${m}_${clean}.tw`).join('|');
    try {
        const j = await fetchJson(
            `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&t=${Date.now()}`,
            { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' } }
        );
        for (const s of (j?.msgArray || [])) {
            // z=盤中成交價（盤後為 '-'）；oz=今日收盤確定值；pz=前一筆；y=昨收
            let raw = s.z;
            if (raw === '-' || raw === '' || raw == null) {
                raw = (s.oz && s.oz !== '-') ? s.oz : (s.pz && s.pz !== '-') ? s.pz : s.y;
            }
            const price = parseFloat(raw);
            const prev = parseFloat(s.y);
            if (price > 0) return { price, prevClose: prev > 0 ? prev : price };
        }
    } catch (e) { /* 交給第三層 */ }
    return null;
};

// 台股第三層：TWSE / TPEx 官方收盤快照。整份抓一次快取起來，之後查表即可。
let _twSnapshot = null;
const fetchTwSnapshot = async () => {
    if (_twSnapshot) return _twSnapshot;
    const map = new Map();
    try {
        const j = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { timeoutMs: 20000 });
        for (const s of j) {
            const price = parseFloat((s.ClosingPrice || '').replace(/,/g, ''));
            const change = parseFloat((s.Change || '0').replace(/[^-\d.]/g, '')) || 0;
            if (price > 0) map.set(s.Code, { price, prevClose: price - change });
        }
    } catch (e) { console.warn('[快照] TWSE 收盤資料抓取失敗'); }
    try {
        const j = await fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', { timeoutMs: 20000 });
        for (const s of j) {
            const price = parseFloat((s.Close || '').replace(/,/g, ''));
            const change = parseFloat((s.Change || '0').replace(/[^-\d.]/g, '')) || 0;
            if (price > 0) map.set(s.SecuritiesCompanyCode, { price, prevClose: price - change });
        }
    } catch (e) { console.warn('[快照] TPEx 收盤資料抓取失敗'); }
    _twSnapshot = map;
    return map;
};

// 台股統一取價：三層退路，與前端 fetchTwStockPriceUnified 對齊。
// 只做 Yahoo 一層的話，興櫃與部分新上市個股會抓不到（這是 v1 版 10 筆失敗的主因）。
const fetchTwPrice = async (stock) => {
    let q = await fetchTwPriceYahoo(stock);
    if (q) return q;
    q = await fetchTwPriceMis(stock);
    if (q) return q;
    const snap = await fetchTwSnapshot();
    return snap.get(stock.symbol.replace(/\.(TW|TWO)$/i, '')) || null;
};

// 美股：Yahoo 優先，Finnhub 當退路。
//
// 為什麼不用 Finnhub 當主力：Finnhub 免費版會擋資料中心 IP。同一把 key 從家用網路
// 打得到（實測 AAPL/VOO/NVDA 皆 HTTP 200），從 GitHub Actions 的機器打則 100% 失敗，
// 這正是排程裡「美股 10 檔全滅、台股 0 失敗」的原因。
// Yahoo 沒有這個限制、不需金鑰、也沒有每分鐘次數限制，實測報價與 Finnhub 完全一致。
const fetchUsPrice = async (symbol) => {
    const q = await fetchYahooQuote(symbol);
    if (q) return q;
    if (!FINNHUB_API_KEY) return null;
    try {
        const j = await fetchJson(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`,
            { retry: 2 }
        );
        if (j?.c > 0) return { price: j.c, prevClose: j.pc || j.c };
    } catch (e) { /* 保留原價 */ }
    return null;
};

// v5.17.0: 期貨報價統一走期交所，日盤與夜盤分別查詢後取較新者。
// 舊版：指數期貨用鉅亨「近全」（不分契約月份）、個股期貨用台積電現貨洗價、
// 微台直接套用小台價格 —— 三者都會讓未實現損益失真。
const fetchTaifexSession = async (product, marketType) => {
    try {
        const resp = await fetch(TAIFEX_MIS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (mywallet-snapshot)',
                Referer: 'https://mis.taifex.com.tw/futures/',
                Origin: 'https://mis.taifex.com.tw'
            },
            body: JSON.stringify(taifexRequestBody(product, marketType))
        });
        if (!resp.ok) return null;
        return (await resp.json())?.RtData?.QuoteList || null;
    } catch (e) { return null; }
};

let _taifexDaily = null;
const fetchTaifexOpenData = async () => {
    if (_taifexDaily === null) {
        try {
            _taifexDaily = await fetchJson('https://openapi.taifex.com.tw/v1/DailyMarketReportFut', { timeoutMs: 25000 });
        } catch (e) {
            console.warn('[快照] 期交所每日行情取得失敗');
            _taifexDaily = false;
        }
    }
    return _taifexDaily || null;
};

const fetchFuturesQuote = async (code, expiry) => {
    const product = TAIFEX_PRODUCTS[String(code || '').toUpperCase()];
    if (!product) return null;
    const month = contractMonthOf(expiry);

    const [day, night] = await Promise.all([
        fetchTaifexSession(product, '0'),
        fetchTaifexSession(product, '1')
    ]);
    // 固定採用日盤收盤價：排程實際觸發時間會被 GitHub 延遲 1～2.5 小時，
    // 若取最新時段，落在夜盤時段的那幾天就會記到盤中價，使歷史數列失去可比性。
    const hit = pickDaySessionFirst([
        day ? pickContract(day, month) : null,
        night ? pickContract(night, month) : null
    ]);
    if (hit) return hit;

    const rows = await fetchTaifexOpenData();
    return rows ? pickFromOpenData(rows, OPEN_DATA_CONTRACT[String(code).toUpperCase()], month, 'day') : null;
};

// --- 主流程 ---

const readCollection = async (userRef, name) => {
    const snap = await userRef.collection(name).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

const readDoc = async (userRef, col, id, fallback) => {
    const doc = await userRef.collection(col).doc(id).get();
    return doc.exists ? doc.data() : fallback;
};

const processUser = async (db, uid, rate, label) => {
    const userRef = db.collection('users').doc(uid);

    const [stocks, loans, realEstate, funds, futuresPositions] = await Promise.all([
        readCollection(userRef, 'stocks'),
        readCollection(userRef, 'loans'),
        readCollection(userRef, 'real_estate'),
        readCollection(userRef, 'funds'),
        readCollection(userRef, 'futures_positions')
    ]);
    const cash = await readDoc(userRef, 'portfolio', 'cash', { twd: 0, usd: 0 });
    const futuresMargin = await readDoc(userRef, 'portfolio', 'futures_margin', { twd: 0, usd: 0 });

    if (!stocks.length && !futuresPositions.length) {
        console.log(`${label} 沒有任何持倉，略過`);
        return;
    }

    // 1. 更新股價（順便寫回 Firestore，這樣下次開網頁看到的就是最新價）
    // 失敗只統計台股／美股筆數，不記錄代號 —— 日誌是公開的。
    let ok = 0, failTw = 0, failUs = 0;
    const batch = db.batch();
    for (const stock of stocks) {
        const isTw = isTwSymbol((stock.symbol || '').toUpperCase());
        const quote = isTw ? await fetchTwPrice(stock) : await fetchUsPrice(stock.symbol);
        if (quote) {
            stock.currentPrice = quote.price;
            stock.previousClose = quote.prevClose;
            batch.update(userRef.collection('stocks').doc(stock.id), {
                currentPrice: quote.price,
                previousClose: quote.prevClose
            });
            ok++;
        } else {
            // 抓不到就沿用資料庫裡的舊價，總比算成 0 好
            if (isTw) failTw++; else failUs++;
        }
        // 台股美股都以 Yahoo 為主，沒有每分鐘次數限制，統一用較短的間隔即可
        await sleep(250);
    }
    const fail = failTw + failUs;

    // 2. 更新期貨現價（依商品與結算日逐一取價，不同契約月份不共用）
    if (futuresPositions.length) {
        const cache = new Map();
        for (const pos of futuresPositions) {
            const sym = (pos.symbol || '').toUpperCase();
            const key = `${sym}|${pos.expiry || ''}`;
            if (!cache.has(key)) cache.set(key, await fetchFuturesQuote(sym, pos.expiry));
            const price = cache.get(key)?.price;
            if (price > 0) {
                pos.currentPrice = price;
                batch.update(userRef.collection('futures_positions').doc(pos.id), { currentPrice: price });
            }
        }
    }
    await batch.commit();
    console.log(`${label} 報價更新：成功 ${ok} 筆、失敗 ${fail} 筆` + (fail ? `（台股 ${failTw}、美股 ${failUs}，已沿用資料庫既有價格）` : ''));

    // 3. 計算並寫入快照
    const snapshot = buildSnapshotFields({
        // hiddenFromList 是「股數歸零後從清單隱藏」的旗標，前端估值時會排除，這裡比照
        twStocks: stocks.filter(s => !s.hiddenFromList && s.currency !== 'USD'),
        usStocks: stocks.filter(s => !s.hiddenFromList && s.currency === 'USD'),
        cash, loans, realEstate, funds, futuresPositions, futuresMargin, rate
    });
    const date = getTaipeiDate();
    await userRef.collection('history').doc(date).set({
        ...snapshot,
        date,
        savedHour: getTaipeiHour(),
        source: 'scheduled', // 標記來源，方便和手動快照區分
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // 注意：這個 repo 是公開的，Actions 日誌任何人都看得到，因此絕對不要印出金額或 uid。
    console.log(`${label} ${date} 快照完成`);
};

const main = async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('缺少 FIREBASE_SERVICE_ACCOUNT 環境變數');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    const db = admin.firestore();

    const rate = await fetchExchangeRate();
    console.log(`匯率 USD/TWD = ${rate}`);

    // 預設只處理 APP_UID 指定的帳號。
    // 這個專案的 Firebase 可能有其他人的帳號（別人也用這個網頁登入過），
    // 排程跑的是專案擁有者的管理金鑰與 API 額度，不應該在未明示的情況下
    // 去動別人的資料，所以「處理全部帳號」必須用 SNAPSHOT_ALL_USERS 明確開啟。
    let uids;
    if (process.env.APP_UID) {
        uids = process.env.APP_UID.split(',').map(s => s.trim()).filter(Boolean);
    } else if (process.env.SNAPSHOT_ALL_USERS === 'true') {
        const refs = await db.collection('users').listDocuments();
        uids = refs.map(r => r.id);
        console.log(`SNAPSHOT_ALL_USERS 已開啟，將處理 ${uids.length} 個帳號`);
    } else {
        throw new Error('缺少 APP_UID：請設定要快照的帳號 uid（多組以逗號分隔）。若確定要處理專案下所有帳號，請改設 SNAPSHOT_ALL_USERS=true');
    }
    if (!uids.length) throw new Error('找不到任何使用者');

    for (let i = 0; i < uids.length; i++) {
        // 用序號當標籤，不把 uid 印進公開日誌
        await processUser(db, uids[i], rate, `[帳號 ${i + 1}/${uids.length}]`);
    }
};

main().catch(err => {
    console.error('快照失敗：', err);
    process.exit(1); // 讓 Actions 標記為失敗，GitHub 會寄信通知
});
