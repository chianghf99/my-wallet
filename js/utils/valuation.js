// 資產估值的共用計算邏輯
//
// 為什麼要有這個檔案：估值公式原本同時存在於兩個地方 —— 前端的 computed（js/main.js）
// 與排程快照（scripts/snapshot.mjs）。只改其中一邊，排程就會默默寫入用舊公式算出來的
// 歷史紀錄，走勢圖上出現對不起來的數字，而且不會有任何錯誤訊息。
// 這裡集中管理，兩邊都 import 同一份。
//
// 全部都是純函式：輸入純資料、輸出數字，不依賴 Vue、不依賴 Firebase，
// 因此可以直接寫測試驗證（見 scripts/test-valuation.mjs）。
//
// 慣例：所有 rate 參數皆為 USD → TWD 匯率；回傳值除另有註明外一律為台幣。

const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

/** 幣別換算係數：美元部位要乘上匯率，台幣部位為 1 */
const rateFor = (item, rate) => (item && item.currency === 'USD' ? rate : 1);

// --- 股票 ---

/** 單一市場的市值、成本、股息與未實現損益（原幣別，不做匯率換算） */
export const calcStats = (list = []) => {
    let value = 0, cost = 0, dividend = 0;
    for (const s of list) {
        value += num(s.currentPrice) * num(s.shares);
        cost += num(s.avgCost) * num(s.shares);
        dividend += num(s.dividends);
    }
    return { value, cost, dividend, pnl: value - cost };
};

/** 曝險市值：槓桿 ETF（正2 等）以 multiplier 放大，反映真實市場曝險（原幣別） */
export const calcStockExposure = (list = []) =>
    list.reduce((acc, s) => acc + num(s.currentPrice) * num(s.shares) * (num(s.multiplier) || 1), 0);

// --- 現金 / 房地產 / 基金 ---

export const calcCashValue = (cash = {}, rate) => num(cash.twd) + num(cash.usd) * rate;

export const calcRealEstateMarket = (list = []) =>
    list.reduce((acc, re) => acc + num(re.marketValue), 0);

export const calcFundsValue = (list = []) =>
    list.reduce((acc, f) => acc + num(f.currentValue) * 1, 0);

/** 基金市值（含匯率換算） */
export const calcFundsValueTwd = (list = [], rate) =>
    list.reduce((acc, f) => acc + num(f.currentValue) * rateFor(f, rate), 0);

export const calcFundsCostTwd = (list = [], rate) =>
    list.reduce((acc, f) => acc + num(f.costBasis) * rateFor(f, rate), 0);

// --- 借款 ---

export const activeLoans = (loans = []) => loans.filter(l => l.status !== 'archived');

/** 總負債：所有未封存帳戶 */
export const calcTotalLoan = (loans = []) =>
    activeLoans(loans).reduce((acc, l) => acc + num(l.balance), 0);

/** 金融負債：排除非投資用途的房貸（自住房貸不算在槓桿裡） */
export const calcFinancialLoans = (loans = []) =>
    activeLoans(loans)
        .filter(l => l.isInvestmentUse === true || l.type !== 'realestate')
        .reduce((acc, l) => acc + num(l.balance), 0);

// --- 期貨 ---

export const calcFuturesUnrealizedPnl = (positions = [], rate) =>
    positions.reduce((acc, p) => {
        const diff = p.direction === 'long'
            ? num(p.currentPrice) - num(p.entryPrice)
            : num(p.entryPrice) - num(p.currentPrice);
        return acc + diff * num(p.contracts) * num(p.multiplier) * rateFor(p, rate);
    }, 0);

/** 保證金帳戶現金（不含未實現損益） */
export const calcFuturesMarginCash = (margin = {}, rate) => num(margin.twd) + num(margin.usd) * rate;

/** 期貨權益 = 保證金現金 + 未實現損益 */
export const calcFuturesEquity = (margin, positions, rate) =>
    calcFuturesMarginCash(margin, rate) + calcFuturesUnrealizedPnl(positions, rate);

export const calcFuturesMarginUsed = (positions = [], rate) =>
    positions.reduce((acc, p) => acc + num(p.marginUsed) * rateFor(p, rate), 0);

/** 合約總值（名目曝險） */
export const calcFuturesExposure = (positions = [], rate) =>
    positions.reduce((acc, p) =>
        acc + num(p.currentPrice) * num(p.contracts) * num(p.multiplier) * rateFor(p, rate), 0);

/**
 * 期貨部位對整體曝險的貢獻。
 * 合約總值之外，還要加上保證金帳戶裡尚未動用的閒置資金 —— 那筆錢屬於金融資產，
 * 不計入的話曝險比會被低估。
 */
export const calcFuturesExposureContribution = (margin, positions, rate) => {
    const equity = calcFuturesEquity(margin, positions, rate);
    const used = calcFuturesMarginUsed(positions, rate);
    return calcFuturesExposure(positions, rate) + Math.max(0, equity - used);
};

// --- 彙總 ---

/**
 * 一次算出所有衍生指標。
 *
 * @param {object} p
 * @param {Array}  p.twStocks   台股持倉
 * @param {Array}  p.usStocks   美股持倉
 * @param {object} p.cash       { twd, usd }
 * @param {Array}  p.loans      借款帳戶
 * @param {Array}  p.realEstate 房地產
 * @param {Array}  p.funds      基金
 * @param {Array}  p.futuresPositions
 * @param {object} p.futuresMargin  { twd, usd }
 * @param {number} p.rate       USD → TWD
 */
export const computePortfolio = ({
    twStocks = [], usStocks = [], cash = {}, loans = [], realEstate = [],
    funds = [], futuresPositions = [], futuresMargin = {}, rate = 1
} = {}) => {
    const twStats = calcStats(twStocks);
    const usStats = calcStats(usStocks);

    const stockValue = twStats.value + usStats.value * rate;
    const cashValue = calcCashValue(cash, rate);
    const realEstateValue = calcRealEstateMarket(realEstate);
    const fundsValue = calcFundsValueTwd(funds, rate);

    const futuresUnrealizedPnl = calcFuturesUnrealizedPnl(futuresPositions, rate);
    const futuresEquity = calcFuturesMarginCash(futuresMargin, rate) + futuresUnrealizedPnl;
    const futuresExposureContribution = calcFuturesExposureContribution(futuresMargin, futuresPositions, rate);

    const totalLoan = calcTotalLoan(loans);
    const financialLoans = calcFinancialLoans(loans);

    const stockExposure = calcStockExposure(twStocks) + calcStockExposure(usStocks) * rate;

    const grandTotalAssets = stockValue + cashValue + realEstateValue + futuresEquity + fundsValue;
    const grandTotalValue = grandTotalAssets - totalLoan;
    const grandTotalExposure = stockExposure + cashValue + realEstateValue + futuresExposureContribution + fundsValue;
    const grandTotalPnL = twStats.pnl + usStats.pnl * rate + futuresUnrealizedPnl;

    // 金融資產／負債刻意排除房地產與自住房貸，避免房產市值稀釋掉真實的投資槓桿
    const financialAssets = stockValue + cashValue + futuresEquity;
    const financialNetWorth = financialAssets - financialLoans;
    const financialExposure = stockExposure + cashValue + futuresExposureContribution;

    return {
        twStats, usStats,
        stockValue, cashValue, realEstateValue, fundsValue,
        futuresUnrealizedPnl, futuresEquity, futuresExposureContribution,
        totalLoan, financialLoans,
        grandTotalAssets, grandTotalValue, grandTotalExposure, grandTotalPnL,
        financialAssets, financialNetWorth, financialExposure,
        // 淨資產為零或負數時沒有有意義的倍率，回傳 1 當中性值
        leverageRatio: financialNetWorth > 0 ? financialAssets / financialNetWorth : 1,
        exposureRatio: financialNetWorth > 0 ? financialExposure / financialNetWorth : 1,
        positionExposureMultiplier: financialAssets > 0 ? financialExposure / financialAssets : 1
    };
};

/** 每日快照要寫進 Firestore 的欄位，由 computePortfolio 的結果整理而成 */
export const buildSnapshotFields = (input) => {
    const p = computePortfolio(input);
    return {
        totalVal: p.grandTotalValue,
        twVal: p.twStats.value,
        usVal: p.usStats.value,
        twCash: (input.cash && input.cash.twd) || 0,
        usCash: (input.cash && input.cash.usd) || 0,
        loan: p.totalLoan,
        totalPnL: p.grandTotalPnL,
        twPnL: p.twStats.pnl,
        usPnL: p.usStats.pnl,
        realestate: p.realEstateValue,
        funds: p.fundsValue,
        futures: p.futuresEquity,
        leverage: p.leverageRatio,
        exposure: p.exposureRatio,
        rate: input.rate
    };
};
