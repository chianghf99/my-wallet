// 每日資產快照 —— 日期歸屬與觸發中繼欄位的回歸測試
//
// 守的是什麼：
//   1. 跨午夜與隔天早上補跑的日期歸屬（< 14:00 台北時間一律算前一天）。
//      GitHub schedule 實測延遲高達 12.3 小時（跨過台北午夜），工作排程器也有
//      「早上開機補跑」的路徑。日盤 13:45 才收盤，14:00 前跑的拿到的必然是昨天的收盤價，
//      寫進今天就會造成「昨天缺一天、今天寫兩次」。
//   2. 二次執行不可抹掉筆電發射的證據（dispatchedAt）。
//      14:35 筆電透過 workflow_dispatch 寫入後，晚上 GitHub schedule 仍會照跑並以
//      set(..., { merge: true }) 覆寫同一份文件（為了自我修復早上的瞬斷舊價）。
//      schedule 那次產生的物件絕對不能含 dispatchedAt key（連 undefined 都不行），
//      否則 merge: true 會把 14:35 留下的 dispatchedAt 洗掉，害看門狗誤報筆電死掉。
//
// 執行：node scripts/test-snapshot.mjs

import {
    SNAPSHOT_CUTOFF_HOUR,
    parseYMD,
    shiftDate,
    getTaipeiClock,
    resolveSnapshotDate,
    normalizeTrigger,
    buildSnapshotMeta,
} from './snapshot-core.mjs';

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
const expectTrue = (name, got) => expect(name, Boolean(got), true);

const throws = (name, fn, expectInMessage) => {
    let msg = null;
    try { fn(); } catch (e) { msg = e.message; }
    if (msg === null) {
        failures++;
        console.log(`❌ ${name}\n   沒有丟例外`);
    } else if (expectInMessage && !msg.includes(expectInMessage)) {
        failures++;
        console.log(`❌ ${name}\n   訊息是「${msg}」，沒提到「${expectInMessage}」`);
    } else {
        console.log(`✅ ${name}`);
    }
};

// --- shiftDate 與邊界 ---------------------------------------------------

expect('一般減一天', shiftDate('2026-11-17', -1), '2026-11-16');
expect('跨月減一天（11/1 → 10/31）', shiftDate('2026-11-01', -1), '2026-10-31');
expect('跨年減一天（1/1 → 去年 12/31）', shiftDate('2026-01-01', -1), '2025-12-31');
expect('平年 3/1 減一天是 2/28', shiftDate('2026-03-01', -1), '2026-02-28');
expect('閏年 3/1 減一天是 2/29', shiftDate('2028-03-01', -1), '2028-02-29');
expect('不合法的日期回 null（2/30 不可以默默進位）', parseYMD('2026-02-30'), null);

// --- getTaipeiClock：UTC 轉台北時區 -------------------------------------

// 2026-11-16 06:37 UTC = 台北 2026-11-16 14:37
expect('06:37 UTC 是台北當天 14 點',
    getTaipeiClock(Date.UTC(2026, 10, 16, 6, 37)),
    { date: '2026-11-16', hour: 14 });

// 2026-11-16 18:58 UTC = 台北 2026-11-17 02:58（遲到 12.3 小時跨過台北午夜）
expect('18:58 UTC 是台北隔天凌晨 2 點',
    getTaipeiClock(Date.UTC(2026, 10, 16, 18, 58)),
    { date: '2026-11-17', hour: 2 });

// 2026-11-16 16:00 UTC = 台北 2026-11-17 00:00（午夜整點必須是 0 而不是 24）
expect('台北午夜整點 hour 必須是 0（防 en-GB 回 24）',
    getTaipeiClock(Date.UTC(2026, 10, 16, 16, 0)),
    { date: '2026-11-17', hour: 0 });

// --- resolveSnapshotDate：門檻 14 點 ------------------------------------

expect('預設收盤門檻是台北 14 點', SNAPSHOT_CUTOFF_HOUR, 14);

expect('14:37 準時執行 → 歸屬當天',
    resolveSnapshotDate({ wallDate: '2026-11-16', hour: 14 }),
    { date: '2026-11-16', wallDate: '2026-11-16', savedHour: 14, shifted: false, overridden: false });

expect('23:59 壓線執行（如 11/19 那次）→ 仍歸屬當天',
    resolveSnapshotDate({ wallDate: '2026-11-19', hour: 23 }),
    { date: '2026-11-19', wallDate: '2026-11-19', savedHour: 23, shifted: false, overridden: false });

expect('00:00 剛跨過午夜 → 退回前一天',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 0 }),
    { date: '2026-11-16', wallDate: '2026-11-17', savedHour: 0, shifted: true, overridden: false });

expect('02:58 凌晨執行（GitHub 延遲 12 小時）→ 退回前一天',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 2 }),
    { date: '2026-11-16', wallDate: '2026-11-17', savedHour: 2, shifted: true, overridden: false });

expect('09:00 早上執行（筆電錯過排程、隔天早上開機補跑）→ 也要退回前一天（擋 <6 漏掉的 8 小時）',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 9 }),
    { date: '2026-11-16', wallDate: '2026-11-17', savedHour: 9, shifted: true, overridden: false });

expect('13:59 日盤剛收但還沒到 14 點門檻 → 退回前一天',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 13 }),
    { date: '2026-11-16', wallDate: '2026-11-17', savedHour: 13, shifted: true, overridden: false });

expect('跨月凌晨遲到（12/1 01:20 → 11/30）',
    resolveSnapshotDate({ wallDate: '2026-12-01', hour: 1 }).date,
    '2026-11-30');

expect('真實 UTC 時間點直接端對端算對（11/16 18:58 UTC = 台北 11/17 02:58 → 歸屬 11/16）',
    resolveSnapshotDate({ now: Date.UTC(2026, 10, 16, 18, 58) }),
    { date: '2026-11-16', wallDate: '2026-11-17', savedHour: 2, shifted: true, overridden: false });

// --- TARGET_DATE 手動覆寫 -----------------------------------------------

expect('TARGET_DATE 可強制指定補跑某一天（不受當下小時影響）',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 15, targetDate: '2026-11-09' }),
    { date: '2026-11-09', wallDate: '2026-11-17', savedHour: 15, shifted: false, overridden: true });

expect('TARGET_DATE 空字串或空白視同沒設',
    resolveSnapshotDate({ wallDate: '2026-11-17', hour: 2, targetDate: '   ' }).date,
    '2026-11-16');

throws('TARGET_DATE 格式打錯要直接中止，不可以默默寫進今天',
    () => resolveSnapshotDate({ wallDate: '2026-11-17', hour: 15, targetDate: '2026/11/09' }),
    'TARGET_DATE');

throws('TARGET_DATE 是不存在的日期（2/30）也要中止',
    () => resolveSnapshotDate({ wallDate: '2026-11-17', hour: 15, targetDate: '2026-02-30' }),
    'TARGET_DATE');

// --- buildSnapshotMeta：守住 merge: true 不洗掉 dispatchedAt -------------

expect('normalizeTrigger 空值回 manual', normalizeTrigger(undefined), 'manual');
expect('normalizeTrigger 保留 schedule', normalizeTrigger('schedule'), 'schedule');
expect('normalizeTrigger 保留 workflow_dispatch', normalizeTrigger('workflow_dispatch'), 'workflow_dispatch');

const dispatchMeta = buildSnapshotMeta({
    date: '2026-11-23',
    savedHour: 14,
    eventName: 'workflow_dispatch',
    nowMs: 1763879700000,
});
expect('筆電 dispatch 時 source 維持 scheduled（不破壞前端手動校正判定）',
    dispatchMeta.source, 'scheduled');
expect('筆電 dispatch 時 trigger 記為 workflow_dispatch',
    dispatchMeta.trigger, 'workflow_dispatch');
expect('筆電 dispatch 時寫入 dispatchedAt 時戳',
    dispatchMeta.dispatchedAt, 1763879700000);

const scheduleMeta = buildSnapshotMeta({
    date: '2026-11-23',
    savedHour: 22,
    eventName: 'schedule',
    nowMs: 1763908800000,
});
expect('GitHub schedule 時 trigger 記為 schedule',
    scheduleMeta.trigger, 'schedule');
expect('GitHub schedule 時絕對不能有 dispatchedAt 這個 key（連 undefined 都不行，否則 Firestore 會報錯或覆蓋）',
    'dispatchedAt' in scheduleMeta, false);

// 模擬 Firestore .set(doc, { merge: true })：先跑 dispatch，晚上再跑 schedule 覆蓋
const mergedInFirestore = { ...dispatchMeta, ...scheduleMeta };
expect('模擬同日先 dispatch 後 schedule merge：dispatchedAt 必須完好保留',
    mergedInFirestore.dispatchedAt, 1763879700000);
expectTrue('模擬同日 merge 後仍看得出最新一次是幾點跑的',
    mergedInFirestore.savedHour === 22);

console.log(failures === 0
    ? '\n✅ 全部通過'
    : `\n❌ 有 ${failures} 項失敗`);

if (failures > 0) {
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error(`${failures} 項測試失敗`);
}
