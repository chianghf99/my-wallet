// js/utils/futures.js 的測試
//
// 測資直接取自期交所即時行情與開放資料的實際回應（2026-07-24 收盤後、07-27 凌晨查詢），
// 涵蓋幾個容易寫錯的地方：日盤／夜盤雙查詢、週契約不可誤認為近月、現貨列不可誤採。
//
// 執行：node scripts/test-futures.mjs

import {
    parseSymbolId, pickContract, pickFreshest, contractMonthOf,
    pickFromOpenData, TAIFEX_PRODUCTS, effectiveStamp, pickDaySessionFirst, isWithinDays, cnyesEntry, cnyesUrl, parseCnyesQuote,
    thirdWednesday, nextSettlementDate, settlementAfter, daysUntilSettlement, settlementStatusOf,
    splitPosition
} from '../js/utils/futures.js';

let fail = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) { fail++; console.log(`❌ ${name}\n     實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(expected)}`); }
    else console.log(`✅ ${name}`);
};

// --- SymbolID 解析 ---
check('CDFH6-F → 202608 日盤', parseSymbolId('CDFH6-F'), { product: 'CDF', contractMonth: '202608', session: 'day' });
check('CDFH6-M → 202608 夜盤', parseSymbolId('CDFH6-M'), { product: 'CDF', contractMonth: '202608', session: 'night' });
check('CDFC7-F → 202703', parseSymbolId('CDFC7-F'), { product: 'CDF', contractMonth: '202703', session: 'day' });
check('週契約 MX5G6-F 不解析', parseSymbolId('MX5G6-F'), null);
check('現貨 CDF-S 不解析', parseSymbolId('CDF-S'), null);
check('夜盤現貨 CDF-P 不解析', parseSymbolId('CDF-P'), null);

// --- 結算日 → 契約月份 ---
check('結算日 2026-08-19', contractMonthOf('2026-08-19'), '202608');
check('結算日空白', contractMonthOf(''), null);

// --- 小台清單：第一筆是週契約，近月不可挑到它 ---
const mxfDay = [
    { SymbolID: 'MXF-S',   DispCName: '小臺指現貨',      CLastPrice: '43654.84', CRefPrice: '44850.81', CDate: '20260724', CTime: '133315' },
    { SymbolID: 'MX5G6-F', DispCName: '小臺指期W5076',   CLastPrice: '43895.00', CRefPrice: '44803.00', CDate: '20260724', CTime: '134455' },
    { SymbolID: 'MX1H6-F', DispCName: '小臺指期W1086',   CLastPrice: '43655.00', CRefPrice: '44718.00', CDate: '20260724', CTime: '121628' },
    { SymbolID: 'MXFH6-F', DispCName: '小臺指期086',     CLastPrice: '43894.00', CRefPrice: '44912.00', CDate: '20260724', CTime: '134500' },
    { SymbolID: 'MXFI6-F', DispCName: '小臺指期096',     CLastPrice: '44075.00', CRefPrice: '45099.00', CDate: '20260724', CTime: '134457' }
];
const mxfNear = pickContract(mxfDay);
check('小台近月挑到 MXFH6-F 而非週契約', mxfNear && mxfNear.symbolId, 'MXFH6-F');
check('小台近月價格', mxfNear && mxfNear.price, 43894);
const mxfSep = pickContract(mxfDay, '202609');
check('指定 202609 挑到 MXFI6-F', mxfSep && mxfSep.symbolId, 'MXFI6-F');
check('查無該月份回傳 null', pickContract(mxfDay, '209912'), null);

// --- 時間戳校正：夜盤標記的是「開始日期」 ---
// 週五 15:00 開始的夜盤收在週六清晨 05:00，期交所回傳 CDate=週五、CTime=045959。
check('夜盤清晨收盤 → 日期進一天',
    effectiveStamp({ CDate: '20260724', CTime: '045959' }, 'night'), '20260725045959');
check('夜盤傍晚時段 → 不進位',
    effectiveStamp({ CDate: '20260727', CTime: '203015' }, 'night'), '20260727203015');
check('日盤不受影響',
    effectiveStamp({ CDate: '20260724', CTime: '134459' }, 'day'), '20260724134459');
check('月底跨月進位',
    effectiveStamp({ CDate: '20260731', CTime: '050000' }, 'night'), '20260801050000');

// --- 日盤 vs 夜盤取較新者（用 TMF 20260724 的實際回應）---
// 實際時序：週五日盤 13:44 收 43891 → 週五夜盤（週六 05:00 收）43378，夜盤才是最新。
const tmfDay = [{ SymbolID: 'TMFH6-F', CLastPrice: '43891.00', CRefPrice: '44912.00', CDate: '20260724', CTime: '134459' }];
const tmfNight = [{ SymbolID: 'TMFH6-M', CLastPrice: '43378.00', CRefPrice: '43891.00', CDate: '20260724', CTime: '045959' }];
const freshest = pickFreshest([pickContract(tmfDay, '202608'), pickContract(tmfNight, '202608')]);
check('收盤後：夜盤（週六05:00）勝過日盤（週五13:44）', freshest && freshest.session, 'night');
check('取到夜盤價格 43378', freshest && freshest.price, 43378);

// 盤中情境：週一日盤進行中，應勝過上週五的夜盤
const monDay = [{ SymbolID: 'TMFH6-F', CLastPrice: '44000.00', CRefPrice: '43378.00', CDate: '20260727', CTime: '103000' }];
const friNight = [{ SymbolID: 'TMFH6-M', CLastPrice: '43378.00', CRefPrice: '43891.00', CDate: '20260724', CTime: '045959' }];
const freshest2 = pickFreshest([pickContract(monDay, '202608'), pickContract(friNight, '202608')]);
check('盤中：當日日盤勝過上一個夜盤', freshest2 && freshest2.session, 'day');
check('取到盤中價格 44000', freshest2 && freshest2.price, 44000);

// 夜盤進行中：當晚 20:30 的夜盤應勝過當日日盤
const sameDayNight = [{ SymbolID: 'TMFH6-M', CLastPrice: '44200.00', CRefPrice: '44000.00', CDate: '20260727', CTime: '203015' }];
const freshest3 = pickFreshest([pickContract(monDay, '202608'), pickContract(sameDayNight, '202608')]);
check('夜盤進行中：夜盤勝出', freshest3 && freshest3.session, 'night');
check('取到夜盤價格 44200', freshest3 && freshest3.price, 44200);

// --- 開放資料退路 ---
// 日期改用相對於今天，否則測資一過期就會被時效檢查擋掉、測試隨時間失效
// 必須用「台北日期」產生測資，不能用執行機器的本地日期。
// isWithinDays 內部刻意換算成台北時間（期交所開放資料是以台北日期標記的），
// 測試若用本地日期，在 UTC 16:00 之後（台北已跨到隔天）兩邊就差一天，
// 「昨天在 1 天內」會變成 false。
//
// 實際踩過：CI 跑在 UTC，排定 06:37 的快照被 GitHub 延後到 17:52 才觸發，
// 測試關卡因此失敗、快照連續兩天沒有寫入。同一份程式在早上跑就正常，
// 所以看起來像「有時候會壞」。
const ymd = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const tp = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
    return `${tp.getFullYear()}${String(tp.getMonth() + 1).padStart(2, '0')}${String(tp.getDate()).padStart(2, '0')}`;
};
const D0 = ymd(0), D1 = ymd(-1), D9 = ymd(-9);
const openRows = [
    { Date: D0, Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2362', Change: '-51', TradingSession: '一般' },
    { Date: D0, Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2390', Change: '-23', TradingSession: '盤後' },
    { Date: D0, Contract: 'CDF', 'ContractMonth(Week)': '202609', Last: '2376', Change: '-54', TradingSession: '一般' },
    { Date: D1, Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2413', Change: '10',  TradingSession: '一般' }
];
const od = pickFromOpenData(openRows, 'CDF', '202608');
check('開放資料：優先採用盤後', od && od.price, 2390);
check('開放資料：昨收 = 收盤 - 漲跌', od && od.prevClose, 2413);
const odSep = pickFromOpenData(openRows, 'CDF', '202609');
check('開放資料：指定 202609', odSep && odSep.price, 2376);

// 週契約在未指定月份時要被排除
const openWeekly = [
    { Date: D0, Contract: 'MTX', 'ContractMonth(Week)': '202607W5', Last: '43895', Change: '-908', TradingSession: '一般' },
    { Date: D0, Contract: 'MTX', 'ContractMonth(Week)': '202608',   Last: '43894', Change: '-1018', TradingSession: '一般' }
];
const odMtx = pickFromOpenData(openWeekly, 'MTX');
check('開放資料：近月排除週契約', odMtx && odMtx.contractMonth, '202608');

// --- 每日快照：固定取日盤，不受排程延遲影響 ---
// GitHub 排程實測延遲 1~2.5 小時，落在夜盤時段（15:00 起）時若取「最新」會記到盤中價。
const dayQ = pickContract(tmfDay, '202608');
const nightQ = pickContract(tmfNight, '202608');
const daily = pickDaySessionFirst([dayQ, nightQ]);
check('快照：夜盤較新時仍取日盤', daily && daily.session, 'day');
check('快照：取到日盤收盤 43891', daily && daily.price, 43891);
check('快照：只有夜盤時退回夜盤', pickDaySessionFirst([null, nightQ]).session, 'night');
check('快照：兩者皆無回傳 null', pickDaySessionFirst([null, null]), null);
const odDay = pickFromOpenData(openRows, 'CDF', '202608', 'day');
check('開放資料：指定 day 取一般時段 2362', odDay && odDay.price, 2362);

// --- 時效檢查：過期的每日行情不可當現價使用 ---
// 實測 7/30 曾取到 7/28 的盤後價，與真實價差 2,780 點（大台一口 55 萬）。
const staleRows = [{ Date: D9, Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2390', Change: '-23', TradingSession: '盤後' }];
check('開放資料：9 天前的資料回傳 null', pickFromOpenData(staleRows, 'CDF', '202608'), null);
const twoDayRows = [{ Date: ymd(-2), Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2390', Change: '-23', TradingSession: '盤後' }];
check('開放資料：2 天前也擋掉（預設只收今天與昨天）', pickFromOpenData(twoDayRows, 'CDF', '202608'), null);
check('開放資料：放寬到 3 天則可用', !!pickFromOpenData(twoDayRows, 'CDF', '202608', 'night', 3), true);
check('開放資料：今日資料可用', !!pickFromOpenData(openRows, 'CDF', '202608'), true);
check('開放資料：回傳值標記為 stale', pickFromOpenData(openRows, 'CDF', '202608').stale, true);
check('開放資料：附帶來源日期', pickFromOpenData(openRows, 'CDF', '202608').sourceDate, D0);
check('isWithinDays：今天在 3 天內', isWithinDays(D0, 3), true);
check('isWithinDays：9 天前不在 3 天內', isWithinDays(D9, 3), false);
check('isWithinDays：昨天在 1 天內', isWithinDays(ymd(-1), 1), true);
check('isWithinDays：2 天前不在 1 天內', isWithinDays(ymd(-2), 1), false);
check('isWithinDays：格式錯誤回傳 false', isWithinDays('abc', 3), false);

// --- 鉅亨備援（期交所擋 Cloudflare 時的即時來源）---
check('大台有鉅亨對應', cnyesEntry('TX').sym, 'TWF:TXF:FUTURES');
check('小台有鉅亨對應', cnyesEntry('MTX').sym, 'TWF:MXF:FUTURES');
check('微台借用小台報價', cnyesEntry('TMF').sym, 'TWF:MXF:FUTURES');
check('微台標記為近似值', cnyesEntry('TMF').approx, true);
check('小台不是近似值', cnyesEntry('MTX').approx, false);
check('個股期貨無鉅亨來源', cnyesEntry('CDF'), null);
check('無來源時不產生網址', cnyesUrl('CDF'), null);
const cn = parseCnyesQuote({ data: [{ '6': 40203, '11': -163 }] }, true);
check('鉅亨解析：成交價', cn.price, 40203);
check('鉅亨解析：昨收 = 成交 - 漲跌', cn.prevClose, 40366);
check('鉅亨解析：帶回 approx 標記', cn.approx, true);
check('鉅亨解析：無成交價回傳 null', parseCnyesQuote({ data: [{}] }), null);

// --- 結算日（交割月份第三個星期三）---
// 期望值以萬年曆逐月核對過，涵蓋 1 號就是星期三、1 號是星期四（第一個星期三落在 7 號）
// 這兩種邊界，以及跨年。
check('2026-11 第三個星期三', thirdWednesday(2026, 11), '2026-11-18');
check('2026-12 第三個星期三', thirdWednesday(2026, 12), '2026-12-16');
check('2027-01 第三個星期三', thirdWednesday(2027, 1), '2027-01-20');
check('2026-04 第三個星期三', thirdWednesday(2026, 4), '2026-04-15');
check('2026-07 第三個星期三（1 號為三）', thirdWednesday(2026, 7), '2026-07-15');
check('2026-10 第三個星期三（1 號為四）', thirdWednesday(2026, 10), '2026-10-21');
// 算出來的日期一定是星期三
for (let m = 1; m <= 12; m++) {
    const d = thirdWednesday(2027, m);
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    check(`2027-${String(m).padStart(2, '0')} 落在星期三且為第 3 個`, [dow, Math.floor((+d.slice(8) - 1) / 7) + 1], [3, 3]);
}

// --- 下一個結算日：本月已過就跳下個月 ---
const at = s => new Date(s);   // 以 UTC 指定時刻，再由函式換算台北日期
check('結算日前一天 → 仍是本月', nextSettlementDate(at('2026-11-17T01:00:00Z')), '2026-11-18');
check('結算日當天 → 仍是本月（當天還能交易）', nextSettlementDate(at('2026-11-18T01:00:00Z')), '2026-11-18');
check('結算日隔天 → 跳下個月', nextSettlementDate(at('2026-11-19T01:00:00Z')), '2026-12-16');
check('12 月已過 → 跨年到隔年 1 月', nextSettlementDate(at('2026-12-20T01:00:00Z')), '2027-01-20');
// UTC 16:00 後台北已是隔天：這一刻台北是 11-19，不該還回 11-18
check('UTC 傍晚仍用台北日期判斷', nextSettlementDate(at('2026-11-18T17:00:00Z')), '2026-12-16');

// --- 轉倉：下一個月契約 ---
check('11 月轉倉 → 12 月結算日', settlementAfter('2026-11-18'), '2026-12-16');
check('12 月轉倉 → 跨年', settlementAfter('2026-12-16'), '2027-01-20');
check('結算日空白 → 退回下一個結算日', settlementAfter('', at('2026-11-17T01:00:00Z')), '2026-11-18');

// --- 倒數與轉倉狀態 ---
check('倒數：隔天為 1', daysUntilSettlement('2026-11-18', at('2026-11-17T01:00:00Z')), 1);
check('倒數：當天為 0', daysUntilSettlement('2026-11-18', at('2026-11-18T01:00:00Z')), 0);
check('倒數：已過為負', daysUntilSettlement('2026-11-18', at('2026-11-20T01:00:00Z')), -2);
check('倒數：格式錯誤回傳 null', daysUntilSettlement('2026-11'), null);
const st = (e, n) => { const s = settlementStatusOf(e, at(n)); return [s.level, s.needsRoll]; };
check('狀態：剩 1 天 → urgent 且需轉倉', st('2026-11-18', '2026-11-17T01:00:00Z'), ['urgent', true]);
check('狀態：當天 → urgent', st('2026-11-18', '2026-11-18T01:00:00Z'), ['urgent', true]);
check('狀態：剩 5 天 → soon 且需轉倉', st('2026-11-18', '2026-11-13T01:00:00Z'), ['soon', true]);
check('狀態：剩 8 天 → ok', st('2026-11-18', '2026-11-10T01:00:00Z'), ['ok', false]);
check('狀態：轉倉後剩 33 天 → ok', st('2026-12-16', '2026-11-13T01:00:00Z'), ['ok', false]);
check('狀態：已過期 → 需轉倉', st('2026-11-18', '2026-11-20T01:00:00Z'), ['expired', true]);
check('狀態：未填結算日 → none 不催', st('', '2026-11-13T01:00:00Z'), ['none', false]);
check('狀態：今日結算的文字', settlementStatusOf('2026-11-18', at('2026-11-18T01:00:00Z')).label, '今日結算');

// --- 部分出場：口數與保證金拆分 ---
check('3 口平 1 口', splitPosition(3, 1, 525750),
    { lots: 1, remaining: 2, releasedMargin: 175250, remainingMargin: 350500, isPartial: true });
check('3 口全平', splitPosition(3, 3, 525750),
    { lots: 3, remaining: 0, releasedMargin: 525750, remainingMargin: 0, isPartial: false });
check('1 口全平', splitPosition(1, 1, 175250).isPartial, false);
// 除不盡時：釋放與剩餘相加必須等於原值，不能各自四捨五入而憑空蒸發
const s1 = splitPosition(3, 1, 100), s2 = splitPosition(3, 2, 100);
check('除不盡：1/3 釋放 33', [s1.releasedMargin, s1.remainingMargin], [33, 67]);
check('除不盡：2/3 釋放 67', [s2.releasedMargin, s2.remainingMargin], [67, 33]);
check('除不盡：兩段相加仍為原值', [s1.releasedMargin + s1.remainingMargin, s2.releasedMargin + s2.remainingMargin], [100, 100]);
// 任何拆法都不該讓保證金總額改變
let drift = 0;
for (let total = 1; total <= 12; total++)
    for (let n = 1; n <= total; n++) {
        const s = splitPosition(total, n, 525750);
        if (s.releasedMargin + s.remainingMargin !== 525750) drift++;
        if (s.lots + s.remaining !== total) drift++;
    }
check('所有拆法：口數與保證金皆不漏不溢', drift, 0);
// 不合法的口數
check('口數 0 不合法', splitPosition(3, 0, 100), null);
check('口數超過持有不合法', splitPosition(3, 4, 100), null);
check('口數為負不合法', splitPosition(3, -1, 100), null);
check('口數非整數不合法', splitPosition(3, 1.5, 100), null);
check('口數空白不合法', splitPosition(3, '', 100), null);
check('持有口數為 0 不合法', splitPosition(0, 1, 100), null);
check('口數為數字字串仍可用', splitPosition(3, '2', 300).lots, 2);
check('未填保證金視為 0', splitPosition(3, 1).releasedMargin, 0);

// --- 商品對應 ---
check('微台有獨立契約', TAIFEX_PRODUCTS.TMF.cid, 'TMF');
check('小型台積電是 QFF', TAIFEX_PRODUCTS.QFF.cid, 'QFF');
check('個股期貨 KindID=4', TAIFEX_PRODUCTS.CDF.kind, '4');
check('指數期貨 KindID=1', TAIFEX_PRODUCTS.TX.kind, '1');

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過');
if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
