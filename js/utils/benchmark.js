// 「如果當初只是買大盤放著」的對照計算
//
// 要回答的問題：我一直來回交易，有沒有贏過單純買進大盤不動？
//
// 這件事最容易做錯的地方是資金進出。中途匯 50 萬進來，帳戶淨值當然變高，
// 但那不是操作賺來的；反過來出金也不是虧損。所以不能直接比淨值曲線。
//
// 這裡用「時間加權報酬率（TWR）」：把每一天的報酬率單獨算出來再串起來，
// 資金在進出當天被中和掉，完全不影響報酬率。這是法人比較績效的標準做法，
// 也讓「借款」「期貨保證金劃轉」這類搬錢動作自動被排除。
//
// 對照標的用「還原價（adjclose）」而非收盤價 —— 還原價含息且已還原分割。
// 實測 0050 近兩年未調整 +143.0%、還原後 +153.2%，用收盤價會低估大盤十個百分點。
//
// 全部都是純函式：輸入純資料、輸出數字，可離線測試（見 scripts/test-benchmark.mjs）。

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

/**
 * 哪些交易屬於「資金進出」而不是投資報酬。
 *
 * 以「台股帳戶＝台股庫存＋台幣現金」為界線來看，錢跨過這條線就算進出：
 *   deposit / withdraw  外部匯入匯出，也包含轉去期貨保證金（有 linkedFuturesTxId）
 *   borrow / repay      向外借入或還出，錢確實跨過了界線
 * 不算進出的：
 *   buy / sell          帳戶內部移動（庫存↔現金），淨值不變
 *   dividend            那是報酬本身，算進去就等於把獲利抵銷掉
 */
const FLOW_TYPES = new Set(['deposit', 'withdraw', 'borrow', 'repay']);
const INFLOW_TYPES = new Set(['deposit', 'borrow']);

/**
 * 把交易紀錄整理成「日期 → 當日淨流入」。
 * @param {Array} transactions 原始交易紀錄
 * @param {string} currency    只計算這個幣別（台股帳戶用 'TWD'）
 */
export const buildFlowMap = (transactions = [], currency = 'TWD') => {
    const map = new Map();
    for (const t of transactions) {
        if (!t || t.symbol !== 'CASH') continue;
        if (!FLOW_TYPES.has(t.type)) continue;
        // 未標幣別的舊資料視為台幣
        const cur = t.currency || 'TWD';
        if (cur !== currency) continue;
        const amt = Math.abs(num(t.totalAmount));
        if (!amt) continue;
        const signed = INFLOW_TYPES.has(t.type) ? amt : -amt;
        map.set(t.date, (map.get(t.date) || 0) + signed);
    }
    return map;
};

/**
 * 時間加權報酬率。
 *
 * 每日報酬 r = (期末淨值 − 當日淨流入) / 期初淨值 − 1，
 * 再把每日報酬連乘起來。流入假設發生在當日開盤前（標準近似）。
 *
 * 期初淨值 <= 0 的那天沒有有意義的報酬率，跳過並計數 —— 寧可少算一天，
 * 也不要讓一個爆掉的數字污染整條曲線。
 *
 * @param {Array<{date:string, value:number}>} series 依日期排序的每日淨值
 * @param {Map<string,number>} flowMap 日期 → 當日淨流入
 * @returns {{points:Array<{date,value,cum}>, totalReturn:number|null, skipped:number}}
 */
export const timeWeightedReturn = (series = [], flowMap = new Map()) => {
    const points = [];
    let cum = 1;
    let skipped = 0;
    for (let i = 0; i < series.length; i++) {
        const { date, value } = series[i];
        if (i === 0) {
            points.push({ date, value, cum: 0 });
            continue;
        }
        const prev = series[i - 1].value;
        const flow = flowMap.get(date) || 0;
        if (prev > 0) {
            cum *= (value - flow) / prev;
        } else {
            skipped++;
        }
        points.push({ date, value, cum: cum - 1 });
    }
    return {
        points,
        totalReturn: points.length ? points[points.length - 1].cum : null,
        skipped
    };
};

/**
 * 對照標的的累積報酬（同樣用 TWR，但標的沒有資金進出，就是單純的價格變化）。
 * 標的在該日沒有報價（休市、停牌）時沿用前一個有效價格。
 *
 * @param {Array<string>} dates 要對齊的日期（通常是快照的日期）
 * @param {Map<string,number>} priceMap 日期 → 還原價
 */
export const benchmarkReturns = (dates = [], priceMap = new Map()) => {
    const points = [];
    let base = null;
    let last = null;
    for (const date of dates) {
        const p = priceMap.get(date);
        if (p > 0) last = p;
        if (last === null) continue;            // 起始日之前還沒有價格，整段略過
        if (base === null) base = last;
        points.push({ date, price: last, cum: last / base - 1 });
    }
    return {
        points,
        totalReturn: points.length ? points[points.length - 1].cum : null
    };
};

/**
 * 影子帳戶：同樣的錢、同樣的進出時點，但全部買對照標的不動。
 *
 * 起始日用實際帳戶當天的淨值全額買進；之後每一筆淨流入就照當日價格加碼，
 * 淨流出就減碼。這條曲線是「金額」，跟實際淨值曲線畫在一起最直覺 ——
 * TWR 回答「報酬率誰高」，這條回答「差多少錢」。
 *
 * 流出超過持有部位時單位數夾在 0（帳上不會出現負持股）。
 */
export const buildShadowPortfolio = (series = [], priceMap = new Map(), flowMap = new Map()) => {
    const points = [];
    let units = null;
    let last = null;
    for (let i = 0; i < series.length; i++) {
        const { date } = series[i];
        const p = priceMap.get(date);
        if (p > 0) last = p;
        if (!(last > 0)) continue;
        if (units === null) {
            units = num(series[i].value) / last;
        } else {
            const flow = flowMap.get(date) || 0;
            if (flow) units = Math.max(0, units + flow / last);
        }
        points.push({ date, price: last, units, value: units * last });
    }
    return points;
};

/** 年化報酬率；期間不足一天或報酬率 <= -100% 時回傳 null */
export const annualize = (totalReturn, days) => {
    if (totalReturn === null || totalReturn === undefined) return null;
    if (!(days > 0)) return null;
    if (totalReturn <= -1) return null;
    return Math.pow(1 + totalReturn, 365 / days) - 1;
};

/** 兩個日期字串相差幾天 */
export const daysBetween = (from, to) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return 0;
    return Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000);
};
