// js/utils/valuation.js 的回歸測試
//
// 這裡刻意保留一份「重構前的舊公式」（legacy* 函式，逐字抄自 v5.13.0 的
// js/main.js computed 與 scripts/snapshot.mjs），用同一批資料跑過兩邊比對，
// 確認抽共用模組沒有改變任何計算結果。
//
// 執行：node scripts/test-valuation.mjs

import { computePortfolio, buildSnapshotFields } from '../js/utils/valuation.js';

// --- 重構前的原始公式（勿修改，這是比對基準）---

const legacy = ({ twStocks, usStocks, cash, loans, realEstate, funds, futuresPositions, futuresMargin, rate }) => {
    const calculateStats = (subset) => {
        let v = 0, c = 0, d = 0;
        subset.forEach(s => { v += s.currentPrice * s.shares; c += s.avgCost * s.shares; d += (s.dividends || 0); });
        return { value: v, cost: c, dividend: d, pnl: v - c };
    };
    const twStats = calculateStats(twStocks);
    const usStats = calculateStats(usStocks);

    const futuresTotalUnrealizedPnL = futuresPositions.reduce((acc, pos) => {
        const diff = pos.direction === 'long' ? (pos.currentPrice - pos.entryPrice) : (pos.entryPrice - pos.currentPrice);
        const pnl = diff * pos.contracts * pos.multiplier;
        const r = pos.currency === 'USD' ? rate : 1;
        return acc + (pnl * r);
    }, 0);
    const futuresTotalMarginCashTwd = (futuresMargin.twd || 0) + ((futuresMargin.usd || 0) * rate);
    const futuresEquity = futuresTotalMarginCashTwd + futuresTotalUnrealizedPnL;
    const futuresTotalMarginUsed = futuresPositions.reduce((acc, pos) => {
        const r = pos.currency === 'USD' ? rate : 1;
        return acc + ((pos.marginUsed || 0) * r);
    }, 0);
    const futuresTotalExposure = futuresPositions.reduce((acc, pos) => {
        const val = pos.currentPrice * pos.contracts * pos.multiplier;
        const r = pos.currency === 'USD' ? rate : 1;
        return acc + (val * r);
    }, 0);

    const mutualFundTotalValue = funds.reduce((acc, f) => acc + ((f.currentValue || 0) * (f.currency === 'USD' ? rate : 1)), 0);
    const realEstateTotalMarket = realEstate.reduce((acc, re) => acc + (re.marketValue || 0), 0);
    const totalLoanBalance = loans.filter(l => l.status !== 'archived').reduce((acc, cur) => acc + (cur.balance || 0), 0);

    const grandTotalAssets = (() => {
        const stockVal = twStats.value + (usStats.value * rate);
        const cashVal = (cash.twd || 0) + ((cash.usd || 0) * rate);
        return stockVal + cashVal + realEstateTotalMarket + futuresEquity + mutualFundTotalValue;
    })();
    const grandTotalExposure = (() => {
        const twExposure = twStocks.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0);
        const usExposure = usStocks.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0) * rate;
        const cashVal = (cash.twd || 0) + ((cash.usd || 0) * rate);
        const futuresExp = futuresTotalExposure + Math.max(0, futuresEquity - futuresTotalMarginUsed);
        return twExposure + usExposure + cashVal + realEstateTotalMarket + futuresExp + mutualFundTotalValue;
    })();
    const grandTotalValue = grandTotalAssets - totalLoanBalance;
    const grandTotalPnL = twStats.pnl + (usStats.pnl * rate) + futuresTotalUnrealizedPnL;

    const financialAssets = (() => {
        const stockVal = twStats.value + (usStats.value * rate);
        const cashVal = (cash.twd || 0) + ((cash.usd || 0) * rate);
        return stockVal + cashVal + futuresEquity;
    })();
    const financialLoans = loans
        .filter(l => l.status !== 'archived')
        .filter(l => l.isInvestmentUse === true || l.type !== 'realestate')
        .reduce((acc, cur) => acc + (cur.balance || 0), 0);
    const financialNetWorth = financialAssets - financialLoans;
    const financialExposure = (() => {
        const twExposure = twStocks.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0);
        const usExposure = usStocks.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0) * rate;
        const cashVal = (cash.twd || 0) + ((cash.usd || 0) * rate);
        const futuresExp = futuresTotalExposure + Math.max(0, futuresEquity - futuresTotalMarginUsed);
        return twExposure + usExposure + cashVal + futuresExp;
    })();

    return {
        twStats, usStats, futuresUnrealizedPnl: futuresTotalUnrealizedPnL, futuresEquity,
        totalLoan: totalLoanBalance, financialLoans,
        grandTotalAssets, grandTotalValue, grandTotalExposure, grandTotalPnL,
        financialAssets, financialNetWorth, financialExposure,
        realEstateValue: realEstateTotalMarket, fundsValue: mutualFundTotalValue,
        leverageRatio: financialNetWorth > 0 ? financialAssets / financialNetWorth : 1,
        exposureRatio: financialNetWorth > 0 ? financialExposure / financialNetWorth : 1,
        positionExposureMultiplier: financialAssets > 0 ? financialExposure / financialAssets : 1
    };
};

// --- 測試資料 ---

const cases = {
    '典型組合（台美股 + 現金 + 期貨 + 房貸 + 基金）': {
        twStocks: [
            { symbol: '2330', shares: 3000, avgCost: 800, currentPrice: 2350, dividends: 42000, currency: 'TWD' },
            { symbol: '00631L', shares: 10000, avgCost: 150, currentPrice: 268, multiplier: 2, currency: 'TWD', isETF: true }
        ],
        usStocks: [
            { symbol: 'AAPL', shares: 100, avgCost: 180, currentPrice: 333.02, dividends: 120, currency: 'USD' },
            { symbol: 'TQQQ', shares: 50, avgCost: 40, currentPrice: 95.5, multiplier: 3, currency: 'USD' }
        ],
        cash: { twd: 850000, usd: 12000 },
        loans: [
            { name: '房貸', balance: 8000000, type: 'realestate', isInvestmentUse: false },
            { name: '質借', balance: 2000000, type: 'other', isInvestmentUse: true },
            { name: '已結清', balance: 0, status: 'archived', type: 'other' }
        ],
        realEstate: [{ name: '自住', marketValue: 18000000, purchaseCost: 12000000 }],
        funds: [
            { name: '全球債', currentValue: 300000, costBasis: 280000, currency: 'TWD' },
            { name: 'US Growth', currentValue: 8000, costBasis: 7000, currency: 'USD' }
        ],
        futuresPositions: [
            { symbol: 'TX', direction: 'long', contracts: 2, entryPrice: 23000, currentPrice: 23450, multiplier: 200, marginUsed: 358000, currency: 'TWD' },
            { symbol: 'MTX', direction: 'short', contracts: 3, entryPrice: 23500, currentPrice: 23450, multiplier: 50, marginUsed: 135000, currency: 'TWD' }
        ],
        futuresMargin: { twd: 500000, usd: 0 },
        rate: 32.35
    },
    '全空帳戶': {
        twStocks: [], usStocks: [], cash: {}, loans: [], realEstate: [],
        funds: [], futuresPositions: [], futuresMargin: {}, rate: 32.35
    },
    '負淨值（負債大於資產）': {
        twStocks: [{ symbol: '2330', shares: 100, avgCost: 900, currentPrice: 500, currency: 'TWD' }],
        usStocks: [], cash: { twd: 10000, usd: 0 },
        loans: [{ name: '融資', balance: 5000000, type: 'other', isInvestmentUse: true }],
        realEstate: [], funds: [], futuresPositions: [], futuresMargin: {}, rate: 32.35
    },
    '純期貨（無股票）': {
        twStocks: [], usStocks: [], cash: { twd: 0, usd: 0 }, loans: [], realEstate: [], funds: [],
        futuresPositions: [
            { symbol: 'TX', direction: 'short', contracts: 1, entryPrice: 24000, currentPrice: 23450, multiplier: 200, marginUsed: 179000, currency: 'TWD' }
        ],
        futuresMargin: { twd: 300000, usd: 0 }, rate: 32.35
    },
    '美元計價期貨與基金': {
        twStocks: [], usStocks: [{ symbol: 'SPY', shares: 10, avgCost: 600, currentPrice: 738.93, currency: 'USD' }],
        cash: { twd: 0, usd: 5000 }, loans: [], realEstate: [],
        funds: [{ name: 'Global', currentValue: 20000, costBasis: 18000, currency: 'USD' }],
        futuresPositions: [
            { symbol: 'MES', direction: 'long', contracts: 2, entryPrice: 6500, currentPrice: 6620, multiplier: 5, marginUsed: 2400, currency: 'USD' }
        ],
        futuresMargin: { twd: 0, usd: 15000 }, rate: 32.35
    }
};

// --- 比對 ---

const KEYS = [
    'grandTotalAssets', 'grandTotalValue', 'grandTotalExposure', 'grandTotalPnL',
    'financialAssets', 'financialNetWorth', 'financialExposure', 'financialLoans',
    'totalLoan', 'futuresEquity', 'futuresUnrealizedPnl', 'realEstateValue', 'fundsValue',
    'leverageRatio', 'exposureRatio', 'positionExposureMultiplier'
];

const near = (a, b) => Math.abs(a - b) < 1e-6;
let failures = 0;

for (const [name, input] of Object.entries(cases)) {
    const before = legacy(input);
    const after = computePortfolio(input);
    const bad = [];
    for (const k of KEYS) {
        if (!near(before[k], after[k])) bad.push(`${k}: 舊 ${before[k]} ≠ 新 ${after[k]}`);
    }
    for (const k of ['value', 'cost', 'pnl', 'dividend']) {
        if (!near(before.twStats[k], after.twStats[k])) bad.push(`twStats.${k} 不一致`);
        if (!near(before.usStats[k], after.usStats[k])) bad.push(`usStats.${k} 不一致`);
    }
    if (bad.length) {
        failures++;
        console.log(`❌ ${name}`);
        bad.forEach(b => console.log(`     ${b}`));
    } else {
        console.log(`✅ ${name}  淨資產 ${Math.round(after.grandTotalValue).toLocaleString()}、槓桿 ${after.leverageRatio.toFixed(2)}x、曝險 ${after.exposureRatio.toFixed(2)}x`);
    }
}

// 快照欄位也要對齊
const snap = buildSnapshotFields(cases['典型組合（台美股 + 現金 + 期貨 + 房貸 + 基金）']);
const expectKeys = ['totalVal', 'twVal', 'usVal', 'twCash', 'usCash', 'loan', 'totalPnL', 'twPnL', 'usPnL', 'realestate', 'funds', 'futures', 'leverage', 'exposure', 'rate'];
const missing = expectKeys.filter(k => snap[k] === undefined);
if (missing.length) { failures++; console.log('❌ 快照缺少欄位:', missing.join(', ')); }
else console.log('✅ 快照欄位齊全');

console.log(failures ? `\n❌ ${failures} 項不一致` : '\n全部通過：重構未改變任何計算結果');
// 在 Node 下以離開碼回報結果；其他 JS 引擎（例如用 jsc 快速跑）則略過
if (typeof process !== 'undefined' && process.exit) process.exit(failures ? 1 : 0);
