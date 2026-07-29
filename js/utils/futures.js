// 期貨報價的共用邏輯（純函式，前端與排程快照共用）
//
// 為什麼需要這一份：期交所即時行情的資料結構有幾個容易踩的坑，
// 前端與排程各寫一次幾乎一定會有一邊寫錯：
//
//   1. 日盤與夜盤是兩次不同的查詢：MarketType=0 是「一般交易時段」（SymbolID 以 -F 結尾），
//      MarketType=1 是「盤後交易時段」（-M 結尾）。只查其中一個，另一個時段就整段抓不到。
//   2. 清單第一筆不一定是近月。小台的清單開頭是週契約（例：MX5G6-F 小臺指期W5076），
//      直接取 [0] 會抓到週契約的價格。
//   3. 個股期貨與指數期貨的 KindID 不同（4 / 1），CID 也未必等於程式內部用的代號。

/** 程式內部代號 → 期交所商品參數 */
export const TAIFEX_PRODUCTS = {
    TX:  { cid: 'TXF', kind: '1', name: '臺股期貨（大台）' },
    MTX: { cid: 'MXF', kind: '1', name: '小型臺指期貨（小台）' },
    TMF: { cid: 'TMF', kind: '1', name: '微型臺指期貨（微台）' },
    CDF: { cid: 'CDF', kind: '4', name: '台積電期貨' },
    QFF: { cid: 'QFF', kind: '4', name: '小型台積電期貨' }
};

export const TAIFEX_MIS_URL = 'https://mis.taifex.com.tw/futures/api/getQuoteList';

/** 組出期交所即時行情的查詢條件；marketType: '0'=日盤 '1'=夜盤 */
export const taifexRequestBody = (product, marketType) => ({
    MarketType: marketType,
    SymbolType: 'F',
    KindID: product.kind,
    CID: product.cid,
    ExpireMonth: '',
    RowSize: '全部',
    PageNo: '',
    SortColumn: '',
    AscDesc: 'A'
});

/** 由部位的結算日推出契約月份 YYYYMM；沒填就回傳 null（改取近月） */
export const contractMonthOf = (expiry) => {
    const m = String(expiry || '').match(/^(\d{4})-(\d{2})/);
    return m ? m[1] + m[2] : null;
};

/**
 * 解析 SymbolID，例如 CDFH6-F。
 * 第 1~3 碼商品、第 4 碼月份（A=1…L=12，非標準期貨月碼）、第 5 碼年份末碼、
 * 尾碼 F=日盤 / M=夜盤。
 *
 * 格式不符者回傳 null —— 這正好排除了週契約（MX5G6-F，第 3 碼是數字）
 * 與現貨（CDF-S / CDF-P），它們都不該被當成月契約報價。
 */
export const parseSymbolId = (symbolId) => {
    const m = String(symbolId || '').match(/^([A-Z]{3})([A-L])(\d)-([FM])$/);
    if (!m) return null;
    const month = m[2].charCodeAt(0) - 64;
    const base = Math.floor(new Date().getFullYear() / 10) * 10;
    let year = base + Number(m[3]);
    // 年份只有末碼，落在過去太遠就進位到下個十年
    if (year < new Date().getFullYear() - 1) year += 10;
    return {
        product: m[1],
        contractMonth: `${year}${String(month).padStart(2, '0')}`,
        session: m[4] === 'M' ? 'night' : 'day'
    };
};

/** 判斷 YYYYMMDD 是否在今天往前 days 天之內（用台北時間比較） */
export const isWithinDays = (yyyymmdd, days, now = new Date()) => {
    if (!/^\d{8}$/.test(String(yyyymmdd || ''))) return false;
    const tp = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    const today = Date.UTC(tp.getFullYear(), tp.getMonth(), tp.getDate());
    const d = String(yyyymmdd);
    const that = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
    const diff = (today - that) / 86400000;
    return diff >= 0 && diff <= days;
};

const toNumber = v => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

/**
 * 併出可比較的時間戳，用來判斷日盤與夜盤誰比較新。
 *
 * 陷阱：期交所把夜盤標記為「開始日期」。週五 15:00 開始的夜盤收在週六清晨 05:00，
 * 回傳的卻是 CDate=週五、CTime=045959。直接把兩者串起來比字串，會得到
 * 「日盤 13:44 > 夜盤 04:59」的錯誤結論，實際上夜盤晚了將近 16 小時。
 * 因此夜盤收在清晨（<06:00）時，日期要進一天才是真正的結束時刻。
 */
export const effectiveStamp = (row, session) => {
    const date = String(row.CDate || '');
    const time = String(row.CTime || '').padStart(6, '0');
    if (session !== 'night' || time >= '060000' || !/^\d{8}$/.test(date)) return date + time;
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '') + time;
};

/**
 * 從一次查詢的結果挑出目標契約。
 * 指定 contractMonth 就對該月份；沒指定則取月份最小者（近月），週契約一律不列入。
 */
export const pickContract = (quoteList = [], contractMonth = null) => {
    const rows = [];
    for (const row of quoteList) {
        const info = parseSymbolId(row.SymbolID);
        if (!info) continue;
        const price = toNumber(row.CLastPrice);
        if (!(price > 0)) continue;
        rows.push({
            symbolId: row.SymbolID,
            contractMonth: info.contractMonth,
            session: info.session,
            price,
            prevClose: toNumber(row.CRefPrice) || price,
            stamp: effectiveStamp(row, info.session)
        });
    }
    if (!rows.length) return null;
    if (contractMonth) {
        return rows.find(r => r.contractMonth === contractMonth) || null;
    }
    rows.sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
    return rows[0];
};

/** 日盤與夜盤的結果中，取時間戳較新的那筆 */
export const pickFreshest = (candidates = []) => {
    const valid = candidates.filter(Boolean);
    if (!valid.length) return null;
    return valid.reduce((best, cur) => (cur.stamp > best.stamp ? cur : best));
};

/**
 * 優先採用日盤（一般交易時段）的那筆，沒有才退回夜盤。
 *
 * 用於每日快照：GitHub 的排程實測會延遲 1～2.5 小時，而期貨夜盤 15:00 就開始，
 * 若一律取「最新時段」，就會變成有些天記日盤收盤、有些天記夜盤盤中，
 * 使走勢圖與每月獲利統計混入不固定的夜盤波動。固定取日盤收盤，
 * 快照結果便與執行時間無關。
 *
 * 前端的「更新期貨價格」不適用這個規則 —— 那裡本來就該顯示當下最新的價格。
 */
export const pickDaySessionFirst = (candidates = []) => {
    const valid = candidates.filter(Boolean);
    if (!valid.length) return null;
    const day = valid.filter(c => c.session === 'day');
    return day.length ? day.reduce((b, c) => (c.stamp > b.stamp ? c : b)) : pickFreshest(valid);
};

/**
 * 期交所每日行情（開放資料）的挑選邏輯 —— 即時行情失敗時的退路。
 * 這份資料用 TradingSession 欄位區分「一般」與「盤後」。preferSession 預設 'night'
 * （盤後發生在後面，較新）；每日快照傳 'day' 以固定取日盤收盤，與即時行情的原則一致。
 * 注意這裡的契約代碼與即時行情不同：大台是 TX、小台 MTX、微台 TMF。
 */
/**
 * 鉅亨「近全」報價 —— 期交所即時行情不可用時的即時來源。
 *
 * 背景：期交所 mis.taifex.com.tw 會封鎖 Cloudflare Worker 的 IP（實測穩定 520，
 * 但同樣的 header 從家用網路直連為 200），導致前端只能退回每日行情，
 * 而那份資料落後一到兩個交易日。鉅亨可經由 Worker 存取且涵蓋日夜盤。
 *
 * 限制：只有指數期貨，且是「近全」（近月連續），不分契約月份；
 * 微台與個股期貨（CDF/QFF）皆無資料。因此僅作為期交所失敗時的備援。
 */
export const CNYES_SYMBOL = { TX: 'TWF:TXF:FUTURES', MTX: 'TWF:MXF:FUTURES' };
export const cnyesUrl = (code) => {
    const sym = CNYES_SYMBOL[String(code || '').toUpperCase()];
    return sym ? `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${sym}` : null;
};
export const parseCnyesQuote = (json) => {
    const q = (json && json.data && json.data[0]) || null;
    const price = q ? toNumber(q['6']) : null;
    if (!(price > 0)) return null;
    const change = toNumber(q['11']);
    return {
        price,
        prevClose: change === null ? price : price - change,
        session: 'unknown',
        nearContinuous: true   // 近全報價，非特定契約月份
    };
};

export const OPEN_DATA_CONTRACT = { TX: 'TX', MTX: 'MTX', TMF: 'TMF', CDF: 'CDF', QFF: 'QFF' };

export const pickFromOpenData = (rows = [], contract, contractMonth = null, preferSession = 'night', maxAgeDays = 1) => {
    const mine = rows.filter(r => (r.Contract || '').trim() === contract);
    if (!mine.length) return null;
    const latest = mine.reduce((a, r) => (r.Date > a ? r.Date : a), '');
    // 這份是每日收盤資料，實測可能落後一到兩個交易日。太舊就回傳 null 讓呼叫端放棄。
    // 窗口刻意收得很緊（預設只接受今天或昨天）：曾發生 7/30 取到 7/28 的盤後價，
    // 與真實價差 2,780 點（大台一口 55 萬）。
    // 兩害相權：「沒更新」使用者看得到，「用舊價當現價」則會安靜地算錯損益。
    // 代價是週一開盤前這條退路會失效 —— 但那時本來就沒有新價格可用。
    if (!isWithinDays(latest, maxAgeDays)) return null;
    let sameDay = mine.filter(r => r.Date === latest);
    if (contractMonth) {
        const byMonth = sameDay.filter(r => r['ContractMonth(Week)'] === contractMonth);
        if (byMonth.length) sameDay = byMonth;
    } else {
        // 沒指定月份時排除週契約（月份欄位形如 202607W5）
        const monthly = sameDay.filter(r => !/W\d/.test(r['ContractMonth(Week)'] || ''));
        if (monthly.length) sameDay = monthly;
    }
    const valid = sameDay.filter(r => toNumber(r.Last) > 0);
    if (!valid.length) return null;
    // preferSession='day' 供每日快照使用，讓退路的取價原則與即時行情一致
    const wanted = preferSession === 'day' ? '一般' : '盤後';
    const pick = valid.find(r => r.TradingSession === wanted) || valid[0];
    const last = toNumber(pick.Last);
    const change = toNumber(pick.Change);
    return {
        price: last,
        prevClose: change === null ? last : last - change,
        session: pick.TradingSession === '盤後' ? 'night' : 'day',
        contractMonth: pick['ContractMonth(Week)'],
        sourceDate: latest,
        stale: true            // 這是每日收盤資料，不是即時報價
    };
};
