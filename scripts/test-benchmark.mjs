// js/utils/benchmark.js 的測試
//
// 重點在「資金進出必須被中和」——那是整個對照功能成立與否的前提。
// 如果中途入金會讓報酬率變高，這個比較就完全沒有意義。
//
// 執行：node scripts/test-benchmark.mjs

import {
    buildFlowMap, timeWeightedReturn, benchmarkReturns,
    buildShadowPortfolio, annualize, daysBetween
} from '../js/utils/benchmark.js';

let fail = 0;
const near = (a, b, eps = 1e-9) => a !== null && b !== null && Math.abs(a - b) < eps;
const check = (name, ok, extra = '') => {
    if (!ok) { fail++; console.log(`❌ ${name}${extra ? '\n     ' + extra : ''}`); }
    else console.log(`✅ ${name}`);
};
const eq = (name, actual, want) =>
    check(name, JSON.stringify(actual) === JSON.stringify(want),
        `實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(want)}`);

// --- buildFlowMap：哪些算資金進出 ---
const txs = [
    { date: '2026-01-05', symbol: 'CASH', type: 'deposit',  totalAmount: 100000, currency: 'TWD' },
    { date: '2026-01-05', symbol: 'CASH', type: 'withdraw', totalAmount: 30000,  currency: 'TWD' },
    { date: '2026-01-06', symbol: 'CASH', type: 'borrow',   totalAmount: 500000, currency: 'TWD' },
    { date: '2026-01-07', symbol: 'CASH', type: 'repay',    totalAmount: 200000, currency: 'TWD' },
    // 轉去期貨保證金：錢離開台股帳戶，要算流出
    { date: '2026-01-08', symbol: 'CASH', type: 'withdraw', totalAmount: 400000, currency: 'TWD', linkedFuturesTxId: 'x1', name: '轉出至期貨保證金' },
    // 以下都不該算
    { date: '2026-01-09', symbol: 'CASH', type: 'dividend', totalAmount: 8000,   currency: 'TWD' },
    { date: '2026-01-09', symbol: '0050', type: 'buy',      totalAmount: 200000, currency: 'TWD' },
    { date: '2026-01-09', symbol: '0050', type: 'sell',     totalAmount: 150000, currency: 'TWD' },
    { date: '2026-01-10', symbol: 'CASH', type: 'deposit',  totalAmount: 5000,   currency: 'USD' },
    // 舊資料沒標幣別，視為台幣
    { date: '2026-01-11', symbol: 'CASH', type: 'deposit',  totalAmount: 20000 }
];
const fm = buildFlowMap(txs, 'TWD');
eq('同日多筆相加（+10萬 −3萬）', fm.get('2026-01-05'), 70000);
eq('借款算流入', fm.get('2026-01-06'), 500000);
eq('還款算流出', fm.get('2026-01-07'), -200000);
eq('期貨保證金劃轉算流出', fm.get('2026-01-08'), -400000);
eq('股息不算流量', fm.get('2026-01-09'), undefined);
eq('買賣不算流量（帳戶內部移動）', fm.has('2026-01-09'), false);
eq('美金進出不計入台股帳戶', fm.get('2026-01-10'), undefined);
eq('未標幣別視為台幣', fm.get('2026-01-11'), 20000);
eq('只取美金時反過來', buildFlowMap(txs, 'USD').get('2026-01-10'), 5000);

// --- TWR：核心性質，資金進出不得影響報酬率 ---
// 情境：淨值 100 萬 → 漲 10% 到 110 萬 → 隔天入金 100 萬（立刻變 210 萬）→ 再漲 10% 到 231 萬
const withFlow = timeWeightedReturn(
    [{ date: 'd1', value: 1000000 }, { date: 'd2', value: 1100000 },
     { date: 'd3', value: 2100000 }, { date: 'd4', value: 2310000 }],
    new Map([['d3', 1000000]])
);
// 沒有入金的對照：100 萬 → 110 萬 → 110 萬 → 121 萬
const noFlow = timeWeightedReturn(
    [{ date: 'd1', value: 1000000 }, { date: 'd2', value: 1100000 },
     { date: 'd3', value: 1100000 }, { date: 'd4', value: 1210000 }],
    new Map()
);
check('入金不影響報酬率（兩者相同）',
    near(withFlow.totalReturn, noFlow.totalReturn),
    `有入金 ${withFlow.totalReturn} / 無入金 ${noFlow.totalReturn}`);
check('報酬率為 +21%', near(withFlow.totalReturn, 0.21, 1e-12), `實得 ${withFlow.totalReturn}`);

// 出金同樣不影響：100 萬 → 110 萬 → 出金 50 萬剩 60 萬 → 漲 10% 到 66 萬
const wd = timeWeightedReturn(
    [{ date: 'd1', value: 1000000 }, { date: 'd2', value: 1100000 },
     { date: 'd3', value: 600000 }, { date: 'd4', value: 660000 }],
    new Map([['d3', -500000]])
);
check('出金不影響報酬率（同為 +21%）', near(wd.totalReturn, 0.21, 1e-12), `實得 ${wd.totalReturn}`);

// 純下跌
const dn = timeWeightedReturn([{ date: 'a', value: 1000 }, { date: 'b', value: 900 }], new Map());
check('下跌 10%', near(dn.totalReturn, -0.1, 1e-12), `實得 ${dn.totalReturn}`);

// 期初淨值 0 的那天要跳過而不是產生 Infinity
const zero = timeWeightedReturn(
    [{ date: 'a', value: 0 }, { date: 'b', value: 500 }, { date: 'c', value: 550 }], new Map());
eq('期初為 0 的日子被略過', zero.skipped, 1);
check('略過後仍算得出後續報酬 +10%', near(zero.totalReturn, 0.1, 1e-12), `實得 ${zero.totalReturn}`);
check('不會出現 Infinity/NaN', Number.isFinite(zero.totalReturn));

eq('只有一天時報酬為 0', timeWeightedReturn([{ date: 'a', value: 100 }], new Map()).totalReturn, 0);
eq('空輸入回 null', timeWeightedReturn([], new Map()).totalReturn, null);

// --- 對照標的 ---
const prices = new Map([['d1', 100], ['d2', 110], ['d4', 121]]);   // d3 休市
const bm = benchmarkReturns(['d1', 'd2', 'd3', 'd4'], prices);
check('標的累積報酬 +21%', near(bm.totalReturn, 0.21, 1e-12), `實得 ${bm.totalReturn}`);
eq('休市日沿用前一個價格', bm.points[2].price, 110);
eq('起始日之前沒價格就略過', benchmarkReturns(['d0', 'd1'], new Map([['d1', 100]])).points.length, 1);

// --- 影子帳戶 ---
const shadow = buildShadowPortfolio(
    [{ date: 'd1', value: 1000000 }, { date: 'd2', value: 0 }, { date: 'd3', value: 0 }],
    new Map([['d1', 100], ['d2', 110], ['d3', 121]]),
    new Map([['d2', 110000]])           // d2 加碼 11 萬，剛好買 1000 單位
);
eq('起始全額買進 10000 單位', shadow[0].units, 10000);
eq('加碼後 11000 單位', shadow[1].units, 11000);
check('d2 市值 121 萬', near(shadow[1].value, 1210000, 1e-6), `實得 ${shadow[1].value}`);
check('d3 市值 133.1 萬', near(shadow[2].value, 1331000, 1e-6), `實得 ${shadow[2].value}`);

// 流出超過持有時不得出現負單位
const drained = buildShadowPortfolio(
    [{ date: 'd1', value: 100000 }, { date: 'd2', value: 0 }],
    new Map([['d1', 100], ['d2', 100]]),
    new Map([['d2', -999999]])
);
eq('流出過大時單位數夾在 0', drained[1].units, 0);

// --- 年化 ---
check('一年 +21% 年化即 +21%', near(annualize(0.21, 365), 0.21, 1e-12));
check('半年 +21% 年化約 +46.4%', near(annualize(0.21, 182.5), Math.pow(1.21, 2) - 1, 1e-9));
eq('天數為 0 回 null', annualize(0.21, 0), null);
eq('虧光（-100%）回 null', annualize(-1, 365), null);
eq('null 進 null 出', annualize(null, 365), null);

eq('日期相差天數', daysBetween('2026-01-01', '2026-12-31'), 364);
eq('格式錯誤回 0', daysBetween('abc', '2026-01-01'), 0);

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過');
if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
