// js/utils/valuation.js 的回歸測試
//
// 這裡刻意保留一份「重構前的舊公式」（legacy* 函式，逐字抄自 v5.13.0 的
// js/main.js computed 與 scripts/snapshot.mjs），用同一批資料跑過兩邊比對，
// 確認抽共用模組沒有改變任何計算結果。
//
// 執行：node scripts/test-valuation.mjs

import { computePortfolio, buildSnapshotFields, buildExposureTrend, calcDailyChange, calcFuturesRiskMetrics } from '../js/utils/valuation.js';

// --- 比對基準 ---
// 原則上逐字對應線上公式，用來確認重構沒有改變計算結果。
// v5.19.0 起基金納入「總未實現損益」與「金融資產」，屬刻意的行為變更，
// 因此基準也同步調整；另於下方加了專門的測試驗證基金確實有被計入。

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
    const mutualFundTotalCost = funds.reduce((acc, f) => acc + ((f.costBasis || 0) * (f.currency === 'USD' ? rate : 1)), 0);
    const mutualFundPnL = mutualFundTotalValue - mutualFundTotalCost;
    const grandTotalPnL = twStats.pnl + (usStats.pnl * rate) + futuresTotalUnrealizedPnL + mutualFundPnL;

    const financialAssets = (() => {
        const stockVal = twStats.value + (usStats.value * rate);
        const cashVal = (cash.twd || 0) + ((cash.usd || 0) * rate);
        return stockVal + cashVal + futuresEquity + mutualFundTotalValue;
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
        return twExposure + usExposure + cashVal + futuresExp + mutualFundTotalValue;
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

// --- 基金確實被計入（v5.19.0）---
const withFunds = cases['典型組合（台美股 + 現金 + 期貨 + 房貸 + 基金）'];
const noFunds = { ...withFunds, funds: [] };
const a = computePortfolio(withFunds), b = computePortfolio(noFunds);
const fundsTwd = 300000 + 8000 * 32.35;          // 台幣基金 + 美元基金換算
const fundsCostTwd = 280000 + 7000 * 32.35;
const near2 = (x, y) => Math.abs(x - y) < 1e-6;
if (!near2(a.fundsValue, fundsTwd)) { failures++; console.log('❌ 基金市值換算不符'); }
else console.log('✅ 基金市值含匯率換算正確');
if (!near2(a.fundsPnl, fundsTwd - fundsCostTwd)) { failures++; console.log('❌ 基金損益不符'); }
else console.log('✅ 基金損益 = 現值 - 成本');
if (!near2(a.grandTotalPnL - b.grandTotalPnL, a.fundsPnl)) { failures++; console.log('❌ 總未實現損益未含基金損益'); }
else console.log('✅ 總未實現損益已含基金損益');
if (!near2(a.financialAssets - b.financialAssets, fundsTwd)) { failures++; console.log('❌ 金融資產未含基金'); }
else console.log('✅ 金融資產已含基金');
if (!near2(a.financialExposure - b.financialExposure, fundsTwd)) { failures++; console.log('❌ 金融曝險未含基金'); }
else console.log('✅ 金融曝險已含基金（1 倍計入）');
if (!(a.leverageRatio < b.leverageRatio)) { failures++; console.log('❌ 納入基金後槓桿比應下降'); }
else console.log(`✅ 納入基金後槓桿比下降（${b.leverageRatio.toFixed(3)} → ${a.leverageRatio.toFixed(3)}）`);
if (!near2(a.grandTotalAssets, b.grandTotalAssets + fundsTwd)) { failures++; console.log('❌ 總資產不符'); }
else console.log('✅ 總資產含基金（本來就有，確認未被改壞）');

// 快照欄位也要對齊
const snap = buildSnapshotFields(cases['典型組合（台美股 + 現金 + 期貨 + 房貸 + 基金）']);
const expectKeys = ['totalVal', 'twVal', 'usVal', 'twCash', 'usCash', 'loan', 'totalPnL', 'twPnL', 'usPnL', 'realestate', 'funds', 'futures', 'leverage', 'exposure', 'rate'];
const missing = expectKeys.filter(k => snap[k] === undefined);
if (missing.length) { failures++; console.log('❌ 快照缺少欄位:', missing.join(', ')); }
else console.log('✅ 快照欄位齊全');


// --- v5.27.0: 從歷史快照還原持倉曝險倍率 ---
// 快照存 leverage=A/N 與 exposure=E/N，相除 N 約掉 → E/A。不需要補任何欄位。
const expect = (name, actual, want) => {
    const ok = JSON.stringify(actual) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`❌ ${name}\n     實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(want)}`); }
    else console.log(`✅ ${name}`);
};

// 用 computePortfolio 產生一組真實快照，再回推，驗證與 positionExposureMultiplier 相同
const scenario = {
    twStocks: [{ currentPrice: 120, shares: 20000, avgCost: 100, multiplier: 2 }],
    usStocks: [{ currentPrice: 500, shares: 100, avgCost: 400, currency: 'USD' }],
    cash: { twd: 500000, usd: 10000 },
    loans: [{ balance: 800000, type: 'other' }],
    funds: [{ currentValue: 250000, costBasis: 200000 }],
    futuresPositions: [{ direction: 'long', contracts: 2, multiplier: 50, entryPrice: 43000, currentPrice: 43800, marginUsed: 350500 }],
    futuresMargin: { twd: 300000 },
    rate: 32
};
const p = computePortfolio(scenario);
const snapRow = { date: '2026-08-14', leverage: p.leverageRatio, exposure: p.exposureRatio };
const back = buildExposureTrend([snapRow]);
const roundTrip = Math.abs(back.points[0].pos - p.positionExposureMultiplier) < 1e-12;
expect('由快照回推 = positionExposureMultiplier', roundTrip, true);
console.log(`     持倉曝險 ${p.positionExposureMultiplier.toFixed(4)}x = 曝險比 ${p.exposureRatio.toFixed(4)} ÷ 槓桿比 ${p.leverageRatio.toFixed(4)}`);

// 統計值
const rows = [
    { date: '2026-08-01', leverage: 1.0, exposure: 1.0 },   // 1.00x
    { date: '2026-08-02', leverage: 1.25, exposure: 2.5 },  // 2.00x
    { date: '2026-08-03', leverage: 2.0, exposure: 6.0 },   // 3.00x
];
const t = buildExposureTrend(rows);
expect('序列值', t.points.map(x => +x.pos.toFixed(4)), [1, 2, 3]);
expect('期初/期末', [t.stats.first, t.stats.last], [1, 3]);
expect('最小/最大', [t.stats.min, t.stats.max], [1, 3]);
expect('平均', +t.stats.avg.toFixed(4), 2);
expect('筆數', t.stats.count, 3);

// 缺欄位／異常值要被略過而非畫出假線
const dirty = buildExposureTrend([
    { date: 'a', leverage: 1.5, exposure: 3 },      // 2.00x
    { date: 'b' },                                   // 早期快照，無欄位
    { date: 'c', leverage: 0, exposure: 2 },         // 分母 0
    { date: 'd', leverage: null, exposure: 2 },
    { date: 'e', leverage: 1, exposure: 1.5 }        // 1.50x
]);
expect('略過缺值後只留有效點', dirty.points.map(x => x.date), ['a', 'e']);
expect('略過筆數', dirty.stats.partial, 3);
expect('空輸入不炸', buildExposureTrend([]).stats.count, 0);
expect('空輸入統計為 null', buildExposureTrend([]).stats.first, null);

// --- calcDailyChange：以各市場自己的 previousClose 算當日漲跌 ---
const dc = calcDailyChange([
    { symbol: 'NVDA', shares: 10, currentPrice: 150, previousClose: 140 }, // +100 / 1400
    { symbol: 'AAPL', shares: 5, currentPrice: 200, previousClose: 220 },  // -100 / 1100
    { symbol: 'NEW', shares: 100, currentPrice: 50, previousClose: 0 },    // 沒昨收 → 必須跳過
]);
expect('calcDailyChange 兩檔抵銷淨額為 0', dc.diff, 0);
expect('calcDailyChange 分母只含有效昨收 (1400+1100=2500)', dc.prevValue, 2500);
expect('calcDailyChange hasData 為 true', dc.hasData, true);

const dcUp = calcDailyChange([
    { symbol: 'SPY', shares: 10, currentPrice: 550, previousClose: 500 },  // +500 / 5000 = +10%
]);
expect('calcDailyChange +10% 漲幅正確', dcUp.diff, 500);
expect('calcDailyChange pct 正確', +dcUp.pct.toFixed(4), 10);
expect('全無昨收時 hasData 為 false（不亂算 +100%）',
    calcDailyChange([{ shares: 10, currentPrice: 100, previousClose: 0 }]).hasData, false);

// --- calcFuturesRiskMetrics：可動用保證金、追繳緩衝、台指可扛點數與統一分級 ---
const fr = calcFuturesRiskMetrics(
    { twd: 500000, usd: 0 },
    [
        { symbol: 'MTX', direction: 'long', contracts: 2, entryPrice: 23000, currentPrice: 23200, multiplier: 50, marginUsed: 350500, currency: 'TWD' },
        { symbol: 'TMF', direction: 'long', contracts: 5, entryPrice: 23000, currentPrice: 23200, multiplier: 10, marginUsed: 175250, currency: 'TWD' },
    ],
    32
);
// 未平倉損益 = (200*2*50) + (200*5*10) = 20000 + 10000 = 30000 → 權益數 = 530000
// 原始保證金 = 525750 → 可動用保證金 = 4250 → 風險指標 = 530000/525750*100 = 100.81% → '危險' (<120%)
// 台指每點價值 = 2*50 + 5*10 = 150（等效 3 口小台）
// 距追繳 (77% = 404827.5) 緩衝 = 125172.5 → 可扛 floor(125172.5 / 150) = 834 點
expect('期貨權益數正確', fr.equity, 530000);
expect('期貨原始保證金正確', fr.initialMargin, 525750);
expect('期貨可動用保證金 = 權益數 - 原始保證金', fr.excessMargin, 4250);
expect('風險指標 100.8% 統一歸類為危險', fr.riskLevel.label, '危險');
expect('台指淨每點價值 = 150', fr.taiexPointValue, 150);
expect('台指等效小台口數 = 3', fr.taiexNetSmallLots, 3);
expect('距追繳可扛點數 = 834', fr.taiexBufferPointsCall, 834);

// 驗證統一分級邊界
const mkRisk = (eq, im) => calcFuturesRiskMetrics({ twd: eq }, [{ symbol: 'MTX', direction: 'long', contracts: 1, entryPrice: 20000, currentPrice: 20000, multiplier: 50, marginUsed: im }], 32).riskLevel.label;
expect('風險指標 200% → 安全', mkRisk(200000, 100000), '安全');
expect('風險指標 135% → 警戒', mkRisk(135000, 100000), '警戒');
expect('風險指標 100% → 危險', mkRisk(100000, 100000), '危險');
expect('風險指標 60% → 低於維持', mkRisk(60000, 100000), '低於維持');
expect('風險指標 20% → 強制平倉', mkRisk(20000, 100000), '強制平倉');

// 多空對沖的淨曝險計算
const hedged = calcFuturesRiskMetrics(
    { twd: 500000 },
    [
        { symbol: 'MTX', direction: 'long', contracts: 3, entryPrice: 20000, currentPrice: 20000, multiplier: 50, marginUsed: 300000 },
        { symbol: 'MTX', direction: 'short', contracts: 1, entryPrice: 20000, currentPrice: 20000, multiplier: 50, marginUsed: 100000 },
    ],
    32
);
expect('多空總曝險 = 400萬', hedged.grossExposure, 4000000);
expect('多空淨曝險 = +200萬', hedged.netExposure, 2000000);
expect('多空淨每點價值 = +100', hedged.taiexPointValue, 100);

console.log(failures ? `\n❌ ${failures} 項不一致` : '\n全部通過：重構未改變任何計算結果');
// 在 Node 下以離開碼回報結果；其他 JS 引擎（例如用 jsc 快速跑）則略過
if (typeof process !== 'undefined' && process.exit) process.exit(failures ? 1 : 0);
