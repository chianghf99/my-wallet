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

const toNumber = v => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

/** CDate + CTime 併成可比較的時間戳字串，用來判斷日盤與夜盤誰比較新 */
const stampOf = (row) => `${row.CDate || ''}${String(row.CTime || '').padStart(6, '0')}`;

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
            stamp: stampOf(row)
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
 * 期交所每日行情（開放資料）的挑選邏輯 —— 即時行情失敗時的退路。
 * 這份資料用 TradingSession 欄位區分「一般」與「盤後」，盤後發生在後面，有資料就優先。
 * 注意這裡的契約代碼與即時行情不同：大台是 TX、小台 MTX、微台 TMF。
 */
export const OPEN_DATA_CONTRACT = { TX: 'TX', MTX: 'MTX', TMF: 'TMF', CDF: 'CDF', QFF: 'QFF' };

export const pickFromOpenData = (rows = [], contract, contractMonth = null) => {
    const mine = rows.filter(r => (r.Contract || '').trim() === contract);
    if (!mine.length) return null;
    const latest = mine.reduce((a, r) => (r.Date > a ? r.Date : a), '');
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
    const pick = valid.find(r => r.TradingSession === '盤後') || valid[0];
    const last = toNumber(pick.Last);
    const change = toNumber(pick.Change);
    return {
        price: last,
        prevClose: change === null ? last : last - change,
        session: pick.TradingSession === '盤後' ? 'night' : 'day',
        contractMonth: pick['ContractMonth(Week)']
    };
};
