// js/utils/futures.js 的測試
//
// 測資直接取自期交所即時行情與開放資料的實際回應（2026-07-24 收盤後、07-27 凌晨查詢），
// 涵蓋幾個容易寫錯的地方：日盤／夜盤雙查詢、週契約不可誤認為近月、現貨列不可誤採。
//
// 執行：node scripts/test-futures.mjs

import {
    parseSymbolId, pickContract, pickFreshest, contractMonthOf,
    pickFromOpenData, TAIFEX_PRODUCTS
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

// --- 日盤 vs 夜盤取較新者 ---
const cdfDay = [{ SymbolID: 'CDFH6-F', CLastPrice: '2362.00', CRefPrice: '2413.00', CDate: '20260724', CTime: '134459' }];
const cdfNight = [{ SymbolID: 'CDFH6-M', CLastPrice: '2335.00', CRefPrice: '2360.00', CDate: '20260724', CTime: '045953' }];
const freshest = pickFreshest([pickContract(cdfDay, '202608'), pickContract(cdfNight, '202608')]);
check('同日：日盤 13:44 比夜盤 04:59 新', freshest && freshest.session, 'day');
check('取到日盤價格 2362', freshest && freshest.price, 2362);

// 夜盤跨日的情境：夜盤時間戳為隔日凌晨，應勝出
const cdfNightNewer = [{ SymbolID: 'CDFH6-M', CLastPrice: '2390.00', CRefPrice: '2362.00', CDate: '20260725', CTime: '045959' }];
const freshest2 = pickFreshest([pickContract(cdfDay, '202608'), pickContract(cdfNightNewer, '202608')]);
check('跨日夜盤勝出', freshest2 && freshest2.session, 'night');
check('取到夜盤價格 2390', freshest2 && freshest2.price, 2390);

// --- 開放資料退路 ---
const openRows = [
    { Date: '20260724', Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2362', Change: '-51', TradingSession: '一般' },
    { Date: '20260724', Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2390', Change: '-23', TradingSession: '盤後' },
    { Date: '20260724', Contract: 'CDF', 'ContractMonth(Week)': '202609', Last: '2376', Change: '-54', TradingSession: '一般' },
    { Date: '20260723', Contract: 'CDF', 'ContractMonth(Week)': '202608', Last: '2413', Change: '10',  TradingSession: '一般' }
];
const od = pickFromOpenData(openRows, 'CDF', '202608');
check('開放資料：優先採用盤後', od && od.price, 2390);
check('開放資料：昨收 = 收盤 - 漲跌', od && od.prevClose, 2413);
const odSep = pickFromOpenData(openRows, 'CDF', '202609');
check('開放資料：指定 202609', odSep && odSep.price, 2376);

// 週契約在未指定月份時要被排除
const openWeekly = [
    { Date: '20260724', Contract: 'MTX', 'ContractMonth(Week)': '202607W5', Last: '43895', Change: '-908', TradingSession: '一般' },
    { Date: '20260724', Contract: 'MTX', 'ContractMonth(Week)': '202608',   Last: '43894', Change: '-1018', TradingSession: '一般' }
];
const odMtx = pickFromOpenData(openWeekly, 'MTX');
check('開放資料：近月排除週契約', odMtx && odMtx.contractMonth, '202608');

// --- 商品對應 ---
check('微台有獨立契約', TAIFEX_PRODUCTS.TMF.cid, 'TMF');
check('小型台積電是 QFF', TAIFEX_PRODUCTS.QFF.cid, 'QFF');
check('個股期貨 KindID=4', TAIFEX_PRODUCTS.CDF.kind, '4');
check('指數期貨 KindID=1', TAIFEX_PRODUCTS.TX.kind, '1');

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n全部通過');
if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
