// js/utils/format.js 的回歸測試
//
// 守的是本地日期與月底邊界的時區正確性：
//   1. getMonthEndDates 不得再踩 toISOString() 的 UTC 時區坑 —— 台北午夜 00:00:00
//      轉成 UTC 會變前一天 16:00，導致「每月獲利總結」把 11/30、10/31 等月底日
//      全部少算一天，月底當天的交易被算進下個月。
//   2. isFlowAfterStartSnapshot 守住起始日當天的入金判斷（快照後才入金才扣除）。
//
// 執行：node scripts/test-format.mjs

import { getLocalDate, getMonthEndDates, isFlowAfterStartSnapshot } from '../js/utils/format.js';

let failures = 0;
const expect = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
        failures++;
        console.log(`❌ ${name}\n   得到 ${g}\n   期望 ${w}`);
    } else {
        console.log(`✅ ${name}`);
    }
};

// 本地建構子 new Date(y, m, d) 固定代表執行環境本地時區的 00:00:00。
// 若走 toISOString()，在 UTC+8（台北）這幾個測試會直接拿到前一天而失敗。
expect('getLocalDate 針對本地午夜物件必須回同一天',
    getLocalDate(new Date(2026, 10, 30, 0, 0, 0)), '2026-11-30');
expect('getLocalDate 針對本地凌晨 00:05 必須回同一天',
    getLocalDate(new Date(2026, 0, 1, 0, 5, 0)), '2026-01-01');

// 2026-11-23 往回推 3 個月（應得 4 個邊界：11/30, 10/31, 09/30, 08/31）
expect('getMonthEndDates 必須精確給出各月最後一日（不含 UTC 退一天）',
    getMonthEndDates(3, new Date(2026, 10, 23)),
    ['2026-11-30', '2026-10-31', '2026-09-30', '2026-08-31']);

// 跨年＋閏年二月檢查（2024-03-15 往回推 2 個月 → 3/31, 2/29, 1/31）
expect('getMonthEndDates 閏年二月必須是 2/29',
    getMonthEndDates(2, new Date(2024, 2, 15)),
    ['2024-03-31', '2024-02-29', '2024-01-31']);

// 跨年 2026-01-10 往回推 2 個月 → 2026-01-31, 2025-12-31, 2025-11-30
expect('getMonthEndDates 跨年正確',
    getMonthEndDates(2, new Date(2026, 0, 10)),
    ['2026-01-31', '2025-12-31', '2025-11-30']);

// --- isFlowAfterStartSnapshot ---
expect('起始日之後的交易必計入',
    isFlowAfterStartSnapshot('2026-11-02', '2026-11-01', null, null), true);
expect('起始日之前的交易不計入',
    isFlowAfterStartSnapshot('2026-10-31', '2026-11-01', 999, 100), false);
expect('起始日當天、發生在快照之後（先拍照後匯款）→ 計入',
    isFlowAfterStartSnapshot('2026-11-01', '2026-11-01', 2000, 1000), true);
expect('起始日當天、發生在快照之前（快照已含這筆錢）→ 不重複扣',
    isFlowAfterStartSnapshot('2026-11-01', '2026-11-01', 500, 1000), false);
expect('起始日當天、缺少時戳時保守不扣',
    isFlowAfterStartSnapshot('2026-11-01', '2026-11-01', null, 1000), false);

console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ 有 ${failures} 項失敗`);
if (failures > 0 && typeof process !== 'undefined' && process.exit) process.exit(1);
