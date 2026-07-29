// js/utils/futures.js 的測試
//
// 測資直接取自期交所即時行情與開放資料的實際回應（2026-07-24 收盤後、07-27 凌晨查詢），
// 涵蓋幾個容易寫錯的地方：日盤／夜盤雙查詢、週契約不可誤認為近月、現貨列不可誤採。
//
// 執行：node scripts/test-futures.mjs

import {
    parseSymbolId, pickContract, pickFreshest, contractMonthOf,
    pickFromOpenData, TAIFEX_PRODUCTS, effectiveStamp, pickDaySessionFirst, isWithinDays, cnyesEntry, cnyesUrl, parseCnyesQuote
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
const ymd = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
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

// --- 商品對應 ---
check('微台有獨立契約', TAIFEX_PRODUCTS.TMF.cid, 'TMF');
check('小型台積電是 QFF', TAIFEX_PRODUCTS.QFF.cid, 'QFF');
check('個股期貨 KindID=4', TAIFEX_PRODUCTS.CDF.kind, '4');
check('指數期貨 KindID=1', TAIFEX_PRODUCTS.TX.kind, '1');

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過');
if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
