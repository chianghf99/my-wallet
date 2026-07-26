// 每日資產快照（排程版）
//
// 目的：前端的 saveDailySnapshot 只有「開網頁」時才會跑，沒開的日子走勢圖就會有洞，
// 每月統計也會拿更早的一筆頂上導致數字偏掉。這支腳本由 GitHub Actions 每個交易日
// 14:30（台北）觸發，抓完當日收盤價後直接寫入 history/{date}。
//
// 計算邏輯刻意對齊 js/main.js 的 computed 們（grandTotalValue / financialAssets /
// leverageRatio / exposureRatio…）。前端那邊改公式時，這裡要一起改。
//
// 需要的環境變數：
//   FIREBASE_SERVICE_ACCOUNT  Firebase 服務帳戶金鑰 JSON（整份貼上）
//   FINNHUB_API_KEY           美股報價用
//   APP_UID                   選填。沒給就自動掃 users 底下所有帳號（單人使用時最方便）

import admin from 'firebase-admin';

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

const fetchJson = async (url, { retry = 1, timeoutMs = 10000 } = {}) => {
    for (let i = 0; i <= retry; i++) {
        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), timeoutMs);
            // Yahoo 等服務會擋沒有 User-Agent 的請求
            const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (mywallet-snapshot)' } });
            clearTimeout(tid);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (i >= retry) throw e;
            await sleep((i + 1) * 800);
        }
    }
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

// 台股：Yahoo v8 chart。marketType 決定先試 .TW 還是 .TWO，失敗再換另一個。
const fetchTwPrice = async (stock) => {
    const clean = stock.symbol.replace(/\.(TW|TWO)$/i, '');
    const first = (stock.marketType === 'otc' || stock.marketType === 'esb') ? '.TWO' : '.TW';
    for (const suffix of [first, first === '.TWO' ? '.TW' : '.TWO']) {
        try {
            const j = await fetchJson(`https://query2.finance.yahoo.com/v8/finance/chart/${clean}${suffix}?interval=1d&range=1d`);
            const meta = j?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice > 0) {
                return {
                    price: meta.regularMarketPrice,
                    prevClose: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice
                };
            }
        } catch (e) { /* 換下一個後綴再試 */ }
    }
    return null;
};

const fetchUsPrice = async (symbol) => {
    if (!FINNHUB_API_KEY) return null;
    try {
        const j = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`);
        if (j?.c > 0) return { price: j.c, prevClose: j.pc || j.c };
    } catch (e) { /* 保留原價 */ }
    return null;
};

// 期貨洗價：大台/小台走鉅亨近全，台積期用台積電現貨（與前端 fetchFuturesPricesDirect 一致）
const fetchFuturesQuotes = async () => {
    const out = { tx: null, mxf: null, tsmc: null };
    const cnyes = async (sym) => {
        try {
            const j = await fetchJson(`https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${sym}`);
            const p = j?.data?.[0]?.['6'];
            return p > 0 ? Number(p) : null;
        } catch (e) { return null; }
    };
    out.tx = await cnyes('TWF:TXF:FUTURES');
    out.mxf = await cnyes('TWF:MXF:FUTURES');
    const tsmc = await fetchTwPrice({ symbol: '2330', marketType: 'tse' });
    out.tsmc = tsmc ? tsmc.price : null;
    return out;
};

const futuresPriceFor = (symbol, q) => {
    const s = (symbol || '').toUpperCase();
    if (s.startsWith('TX')) return q.tx;
    if (s.startsWith('MTX') || s.startsWith('MXF') || s.startsWith('TMF')) return q.mxf || q.tx;
    if (s.startsWith('CDF') || s.startsWith('QDF')) return q.tsmc;
    return null;
};

// --- 估值：對齊 js/main.js 的 computed ---

const buildSnapshot = ({ stocks, cash, loans, realEstate, funds, futuresPositions, futuresMargin, rate }) => {
    const twList = stocks.filter(s => s.currency !== 'USD');
    const usList = stocks.filter(s => s.currency === 'USD');

    const statsOf = list => list.reduce((acc, s) => {
        const v = (s.currentPrice || 0) * (s.shares || 0);
        const c = (s.avgCost || 0) * (s.shares || 0);
        return { value: acc.value + v, cost: acc.cost + c, pnl: acc.pnl + (v - c) };
    }, { value: 0, cost: 0, pnl: 0 });

    const twStats = statsOf(twList);
    const usStats = statsOf(usList);

    const exposureOf = list => list.reduce((acc, s) => acc + (s.currentPrice || 0) * (s.shares || 0) * (s.multiplier || 1), 0);

    const cashTwd = cash.twd || 0;
    const cashUsd = cash.usd || 0;
    const cashVal = cashTwd + cashUsd * rate;

    const futuresUnrealized = futuresPositions.reduce((acc, p) => {
        const diff = p.direction === 'long' ? (p.currentPrice - p.entryPrice) : (p.entryPrice - p.currentPrice);
        const pnl = diff * (p.contracts || 0) * (p.multiplier || 0);
        return acc + pnl * (p.currency === 'USD' ? rate : 1);
    }, 0);
    const futuresMarginCash = (futuresMargin.twd || 0) + (futuresMargin.usd || 0) * rate;
    const futuresEquity = futuresMarginCash + futuresUnrealized;
    const futuresMarginUsed = futuresPositions.reduce((acc, p) => acc + (p.marginUsed || 0) * (p.currency === 'USD' ? rate : 1), 0);
    const futuresExposure = futuresPositions.reduce((acc, p) => {
        const val = (p.currentPrice || 0) * (p.contracts || 0) * (p.multiplier || 0);
        return acc + val * (p.currency === 'USD' ? rate : 1);
    }, 0);

    const fundsValue = funds.reduce((acc, f) => acc + (f.currentValue || 0) * (f.currency === 'USD' ? rate : 1), 0);
    const realEstateValue = realEstate.reduce((acc, r) => acc + (r.marketValue || 0), 0);

    const activeLoans = loans.filter(l => l.status !== 'archived');
    const totalLoan = activeLoans.reduce((acc, l) => acc + (l.balance || 0), 0);
    const financialLoans = activeLoans
        .filter(l => l.isInvestmentUse === true || l.type !== 'realestate')
        .reduce((acc, l) => acc + (l.balance || 0), 0);

    const stockVal = twStats.value + usStats.value * rate;
    const grandTotalAssets = stockVal + cashVal + realEstateValue + futuresEquity + fundsValue;
    const grandTotalValue = grandTotalAssets - totalLoan;
    const grandTotalPnL = twStats.pnl + usStats.pnl * rate + futuresUnrealized;

    const financialAssets = stockVal + cashVal + futuresEquity;
    const financialNetWorth = financialAssets - financialLoans;
    const futuresExp = futuresExposure + Math.max(0, futuresEquity - futuresMarginUsed);
    const financialExposure = exposureOf(twList) + exposureOf(usList) * rate + cashVal + futuresExp;

    return {
        totalVal: grandTotalValue,
        twVal: twStats.value,
        usVal: usStats.value,
        twCash: cashTwd,
        usCash: cashUsd,
        loan: totalLoan,
        totalPnL: grandTotalPnL,
        twPnL: twStats.pnl,
        usPnL: usStats.pnl,
        realestate: realEstateValue,
        funds: fundsValue,
        futures: futuresEquity,
        leverage: financialNetWorth > 0 ? financialAssets / financialNetWorth : 1,
        exposure: financialNetWorth > 0 ? financialExposure / financialNetWorth : 1,
        rate
    };
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

const processUser = async (db, uid, rate) => {
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
        console.log(`[${uid}] 沒有任何持倉，略過`);
        return;
    }

    // 1. 更新股價（順便寫回 Firestore，這樣下次開網頁看到的就是最新價）
    let ok = 0, fail = 0;
    const batch = db.batch();
    for (const stock of stocks) {
        const quote = isTwSymbol((stock.symbol || '').toUpperCase())
            ? await fetchTwPrice(stock)
            : await fetchUsPrice(stock.symbol);
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
            fail++;
        }
        await sleep(isTwSymbol((stock.symbol || '').toUpperCase()) ? 250 : 1100); // Finnhub 免費版每分鐘 60 次
    }

    // 2. 更新期貨現價
    const hasTwFutures = futuresPositions.some(p => futuresPriceFor(p.symbol, { tx: 1, mxf: 1, tsmc: 1 }));
    if (hasTwFutures) {
        const quotes = await fetchFuturesQuotes();
        for (const pos of futuresPositions) {
            const price = futuresPriceFor(pos.symbol, quotes);
            if (price > 0) {
                pos.currentPrice = price;
                batch.update(userRef.collection('futures_positions').doc(pos.id), { currentPrice: price });
            }
        }
    }
    await batch.commit();
    console.log(`[${uid}] 報價更新：成功 ${ok} 筆、失敗 ${fail} 筆`);

    // 3. 計算並寫入快照
    const snapshot = buildSnapshot({ stocks, cash, loans, realEstate, funds, futuresPositions, futuresMargin, rate });
    const date = getTaipeiDate();
    await userRef.collection('history').doc(date).set({
        ...snapshot,
        date,
        savedHour: getTaipeiHour(),
        source: 'scheduled', // 標記來源，方便和手動快照區分
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[${uid}] ${date} 快照完成：淨資產 ${Math.round(snapshot.totalVal).toLocaleString()}、期貨權益 ${Math.round(snapshot.futures).toLocaleString()}`);
};

const main = async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('缺少 FIREBASE_SERVICE_ACCOUNT 環境變數');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    const db = admin.firestore();

    const rate = await fetchExchangeRate();
    console.log(`匯率 USD/TWD = ${rate}`);

    let uids;
    if (process.env.APP_UID) {
        uids = [process.env.APP_UID];
    } else {
        // 單人使用時不必特地設定 uid，直接掃出底下有資料的帳號
        const refs = await db.collection('users').listDocuments();
        uids = refs.map(r => r.id);
    }
    if (!uids.length) throw new Error('找不到任何使用者');

    for (const uid of uids) await processUser(db, uid, rate);
};

main().catch(err => {
    console.error('快照失敗：', err);
    process.exit(1); // 讓 Actions 標記為失敗，GitHub 會寄信通知
});
