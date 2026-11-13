// 期貨報價的共用邏輯（純函式，前端與排程快照共用）
//
// 為什麼需要這一份：期交所即時行情的資料結構有幾個容易踩的坑，
// 前端與排程各寫一次幾乎一定會有一邊寫錯：
//
//   1. 日盤與夜盤是兩次不同的查詢：MarketType=0 是「一般交易時段」（SymbolID 以 -F 結尾），
//      MarketType=1 是「盤後交易時段」（-M 結尾）。只查其中一個，另一個時段就整段抓不到。
//   2. 清單第一筆不一定是近月。小台的清單開頭是週契約（例：MX5G6-F 小臺指期W5076），
//      直接取 [0] 會抓到週契約的價格。
//   3. 個股期貨與指數期貨的 KindID 不同（4 / 1），CID 也未必等於程式內部用的代號。

/** 程式內部代號 → 期交所商品參數 */
export const TAIFEX_PRODUCTS = {
    TX:  { cid: 'TXF', kind: '1', name: '臺股期貨（大台）' },
    MTX: { cid: 'MXF', kind: '1', name: '小型臺指期貨（小台）' },
    TMF: { cid: 'TMF', kind: '1', name: '微型臺指期貨（微台）' },
    CDF: { cid: 'CDF', kind: '4', name: '台積電期貨' },
    QFF: { cid: 'QFF', kind: '4', name: '小型台積電期貨' }
};

/**
 * 期交所保證金（新臺幣／每口）。
 *
 * 來源：期交所「結算保證金、維持保證金及原始保證金一覽表」，2026-08-06 由使用者提供的公告擷取。
 * 期交所會依指數波動不定期調整，**看到公告請回來改這裡**，這是唯一的來源。
 *
 * 為什麼要記在程式裡：新增部位時「佔用保證金」會自動帶入 initial 值，而
 * 首頁的維持率（風控指標）＝ 期貨權益 ÷ 佔用保證金。這個數字寫錯，風控就整個失真 ——
 * v5.24.0 以前寫死的是舊制（大台 179,000、小台 45,000、微台 11,100），
 * 比實際少了 3~4 倍，維持率會顯示成實際的 3~4 倍，等於把風險看反了。
 *
 * maintenance / initial ≈ 76.7%，與介面上「77% 為維持保證金」的分級一致；
 * 調整保證金時這個比例大致不變，但仍應一併核對。
 *
 * 個股期貨（CDF／QFF）不在這張表裡 —— 它的保證金是契約價值的一定比例（隨股價浮動），
 * 沒有固定金額，因此只能是估計值，開倉後請依券商實際佔用金額修正。
 */
export const TAIFEX_MARGINS = {
    asOf: '2026-08-06',
    source: '期交所保證金一覽表',
    products: {
        TX:  { clearing: 519000, maintenance: 538000, initial: 701000, name: '臺股期貨（大台）' },
        MTX: { clearing: 129750, maintenance: 134500, initial: 175250, name: '小型臺指期貨（小台）' },
        TMF: { clearing:  25950, maintenance:  26900, initial:  35050, name: '微型臺指期貨（微台）' },
        // 以下為個股期貨，非表列固定值，僅為概估
        CDF: { initial: 300000, estimated: true, name: '台積電期貨（2000 股）' },
        QFF: { initial:  15000, estimated: true, name: '小型台積電期貨（100 股）' }
    }
};

/** 契約乘數（點數 → 新臺幣） */
export const CONTRACT_MULTIPLIERS = { TX: 200, MTX: 50, TMF: 10, CDF: 2000, QFF: 100 };

/** 新增部位時要帶入的預設值；查無代號回傳 null */
export const futuresDefaultsFor = (symbol) => {
    const m = TAIFEX_MARGINS.products[symbol];
    const mult = CONTRACT_MULTIPLIERS[symbol];
    if (!m || !mult) return null;
    return {
        multiplier: mult,
        marginUsed: m.initial,
        maintenance: m.maintenance || null,
        estimated: !!m.estimated,
        name: m.name
    };
};

export const TAIFEX_MIS_URL = 'https://mis.taifex.com.tw/futures/api/getQuoteList';

/** 組出期交所即時行情的查詢條件；marketType: '0'=日盤 '1'=夜盤 */
export const taifexRequestBody = (product, marketType) => ({
    MarketType: marketType,
    SymbolType: 'F',
    KindID: product.kind,
    CID: product.cid,
    ExpireMonth: '',
    RowSize: '全部',
    PageNo: '',
    SortColumn: '',
    AscDesc: 'A'
});

/** 由部位的結算日推出契約月份 YYYYMM；沒填就回傳 null（改取近月） */
export const contractMonthOf = (expiry) => {
    const m = String(expiry || '').match(/^(\d{4})-(\d{2})/);
    return m ? m[1] + m[2] : null;
};

/**
 * 解析 SymbolID，例如 CDFH6-F。
 * 第 1~3 碼商品、第 4 碼月份（A=1…L=12，非標準期貨月碼）、第 5 碼年份末碼、
 * 尾碼 F=日盤 / M=夜盤。
 *
 * 格式不符者回傳 null —— 這正好排除了週契約（MX5G6-F，第 3 碼是數字）
 * 與現貨（CDF-S / CDF-P），它們都不該被當成月契約報價。
 */
export const parseSymbolId = (symbolId) => {
    const m = String(symbolId || '').match(/^([A-Z]{3})([A-L])(\d)-([FM])$/);
    if (!m) return null;
    const month = m[2].charCodeAt(0) - 64;
    const base = Math.floor(new Date().getFullYear() / 10) * 10;
    let year = base + Number(m[3]);
    // 年份只有末碼，落在過去太遠就進位到下個十年
    if (year < new Date().getFullYear() - 1) year += 10;
    return {
        product: m[1],
        contractMonth: `${year}${String(month).padStart(2, '0')}`,
        session: m[4] === 'M' ? 'night' : 'day'
    };
};

/**
 * 「今天」的台北日期，回傳 UTC epoch（毫秒）以便做整日數相減。
 *
 * 為什麼不能直接用本機日期：這份檔案前端與排程共用，排程跑在 UTC 的 runner 上。
 * UTC 16:00 之後台北已經是隔天，用本機日期算會整天差一天 ——
 * 曾經因此讓 test-futures 在台灣傍晚之後必定失敗，連帶擋掉兩個交易日的快照。
 */
const taipeiTodayUTC = (now = new Date()) => {
    const tp = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    return Date.UTC(tp.getFullYear(), tp.getMonth(), tp.getDate());
};

/** 判斷 YYYYMMDD 是否在今天往前 days 天之內（用台北時間比較） */
export const isWithinDays = (yyyymmdd, days, now = new Date()) => {
    if (!/^\d{8}$/.test(String(yyyymmdd || ''))) return false;
    const today = taipeiTodayUTC(now);
    const d = String(yyyymmdd);
    const that = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
    const diff = (today - that) / 86400000;
    return diff >= 0 && diff <= days;
};

// ---------------------------------------------------------------------------
// 結算日（契約行事曆）
//
// 臺指期與個股期貨的最後交易日都是「交割月份第三個星期三」，隔日為最後結算日。
// 使用者實際上只交易流動性最好的月契約，所以結算日永遠落在這一天 ——
// 以前是一個空白的 date 欄位要自己翻日曆填，這是最容易填錯也最煩的一步。
//
// 注意：期交所遇國定假日會提前最後交易日（例如第三個星期三恰為假日），
// 本專案不內建假日表，因此這裡算出來的是「預設值」而非保證值，欄位仍可改。
// ---------------------------------------------------------------------------

/**
 * 把一個部位拆成「這次要動的口數」與「留下來的口數」，並按比例分攤保證金。
 *
 * 為什麼要有部分出場：平倉與轉倉原本都是整筆結算（直接吃 pos.contracts），
 * 所以想分批出場只能在建倉時就拆成好幾筆部位 —— 那又讓每月轉倉要重複操作好幾次。
 *
 * 保證金刻意先算「釋放」再用相減得到「剩餘」，不是兩邊各乘比例：
 * 3 口拆 1 口時 100 ÷ 3 除不盡，各自四捨五入會變成 33 + 33 = 66，
 * 憑空少掉 1 元，而維持率＝期貨權益 ÷ 佔用保證金，分母會一直慢慢飄掉。
 *
 * 回傳 null 代表口數不合法（非整數、小於 1、或超過持有口數）。
 */
export const splitPosition = (totalContracts, lots, marginUsed = 0) => {
    const total = Number(totalContracts);
    const n = Number(lots);
    if (!Number.isInteger(total) || total < 1) return null;
    if (!Number.isInteger(n) || n < 1 || n > total) return null;
    const margin = Number(marginUsed) || 0;
    const released = n === total ? margin : Math.round(margin * n / total);
    return {
        lots: n,
        remaining: total - n,
        releasedMargin: released,
        remainingMargin: margin - released,
        isPartial: n < total
    };
};

/**
 * 把新建的口數併入既有部位，算出合併後的口數、加權平均建倉價與佔用保證金。
 *
 * 為什麼要併：期貨同一個契約在券商那邊本來就是一筆淨部位、一個均價。
 * 分批進場若在這裡留成好幾列，每個月轉倉就要對同一個契約重複操作好幾次。
 *
 * 為什麼可以併：券商之所以能合併又不必問你平的是哪一口，是因為期貨每日結算 ——
 * 所有未平倉口數的帳面成本每天都被重設成同一個結算價，先買後買根本沒有差別。
 * 本專案不做每日結算（一路用建倉價扛到出場），所以這裡改用加權平均；
 * 它與 FIFO 的「累計損益」完全相同，差別只在損益落在哪一期。
 *
 * 建倉明細不會因此消失 —— 每次建倉都另外寫了一筆 type:'open' 交易紀錄。
 *
 * 回傳 null 代表參數不合法（口數非正數）。
 */
export const mergePositions = (existing, added) => {
    const c1 = Number(existing && existing.contracts), c2 = Number(added && added.contracts);
    if (!(c1 > 0) || !(c2 > 0)) return null;
    const p1 = Number(existing.entryPrice) || 0, p2 = Number(added.entryPrice) || 0;
    const total = c1 + c2;
    return {
        contracts: total,
        // 四捨五入到小數第 4 位：期貨報價最細到小數點後 2 位，留兩位緩衝即可，
        // 不留的話連續加碼會累積浮點誤差。
        entryPrice: Number(((p1 * c1 + p2 * c2) / total).toFixed(4)),
        marginUsed: (Number(existing.marginUsed) || 0) + (Number(added.marginUsed) || 0)
    };
};

/** 某年某月（month 為 1~12）的第三個星期三，回傳 'YYYY-MM-DD' */
export const thirdWednesday = (year, month) => {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=日
    const firstWed = 1 + ((3 - firstDow) + 7) % 7;
    return `${year}-${String(month).padStart(2, '0')}-${String(firstWed + 14).padStart(2, '0')}`;
};

/**
 * 下一個還沒過的結算日（含今天）。
 * 本月的第三個星期三若已過，就跳到下個月。
 */
export const nextSettlementDate = (now = new Date()) => {
    const today = taipeiTodayUTC(now);
    const y = new Date(today).getUTCFullYear();
    const m = new Date(today).getUTCMonth() + 1;
    const thisMonth = thirdWednesday(y, m);
    if (Date.parse(thisMonth + 'T00:00:00Z') >= today) return thisMonth;
    return m === 12 ? thirdWednesday(y + 1, 1) : thirdWednesday(y, m + 1);
};

/**
 * 某個結算日的「下一個月契約」結算日，給轉倉用。
 * expiry 格式不符時退回 nextSettlementDate()，不會回傳空字串卡住表單。
 */
export const settlementAfter = (expiry, now = new Date()) => {
    const m = String(expiry || '').match(/^(\d{4})-(\d{2})/);
    if (!m) return nextSettlementDate(now);
    const y = +m[1], mo = +m[2];
    return mo === 12 ? thirdWednesday(y + 1, 1) : thirdWednesday(y, mo + 1);
};

/** 距結算日還有幾天（台北時間，今天=0，已過為負）；格式不符回傳 null */
export const daysUntilSettlement = (expiry, now = new Date()) => {
    const m = String(expiry || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - taipeiTodayUTC(now)) / 86400000;
};

/**
 * 部位的轉倉狀態，給介面直接用。
 *
 * 解決的問題：每月轉倉時要一筆一筆核對「這口轉過了沒」。
 * 轉過的部位結算日會跳到下個月，剩餘天數自然拉開（通常 >21 天），
 * 所以只要把天數算出來標上顏色，轉完與沒轉完一眼就分得出來，不必記。
 *
 * level: none（沒填結算日）/ ok / soon（7 天內）/ urgent（2 天內）/ expired（已過）
 */
export const settlementStatusOf = (expiry, now = new Date()) => {
    const days = daysUntilSettlement(expiry, now);
    if (days === null) return { days: null, level: 'none', label: '未設結算日', needsRoll: false };
    if (days < 0) return { days, level: 'expired', label: `已過期 ${-days} 天`, needsRoll: true };
    if (days === 0) return { days, level: 'urgent', label: '今日結算', needsRoll: true };
    if (days <= 2) return { days, level: 'urgent', label: `剩 ${days} 天`, needsRoll: true };
    if (days <= 7) return { days, level: 'soon', label: `剩 ${days} 天`, needsRoll: true };
    return { days, level: 'ok', label: `剩 ${days} 天`, needsRoll: false };
};

const toNumber = v => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return isFinite(n) ? n : null;
};

/**
 * 併出可比較的時間戳，用來判斷日盤與夜盤誰比較新。
 *
 * 陷阱：期交所把夜盤標記為「開始日期」。週五 15:00 開始的夜盤收在週六清晨 05:00，
 * 回傳的卻是 CDate=週五、CTime=045959。直接把兩者串起來比字串，會得到
 * 「日盤 13:44 > 夜盤 04:59」的錯誤結論，實際上夜盤晚了將近 16 小時。
 * 因此夜盤收在清晨（<06:00）時，日期要進一天才是真正的結束時刻。
 */
export const effectiveStamp = (row, session) => {
    const date = String(row.CDate || '');
    const time = String(row.CTime || '').padStart(6, '0');
    if (session !== 'night' || time >= '060000' || !/^\d{8}$/.test(date)) return date + time;
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '') + time;
};

/**
 * 從一次查詢的結果挑出目標契約。
 * 指定 contractMonth 就對該月份；沒指定則取月份最小者（近月），週契約一律不列入。
 */
export const pickContract = (quoteList = [], contractMonth = null) => {
    const rows = [];
    for (const row of quoteList) {
        const info = parseSymbolId(row.SymbolID);
        if (!info) continue;
        const price = toNumber(row.CLastPrice);
        if (!(price > 0)) continue;
        rows.push({
            symbolId: row.SymbolID,
            contractMonth: info.contractMonth,
            session: info.session,
            price,
            prevClose: toNumber(row.CRefPrice) || price,
            stamp: effectiveStamp(row, info.session)
        });
    }
    if (!rows.length) return null;
    if (contractMonth) {
        return rows.find(r => r.contractMonth === contractMonth) || null;
    }
    rows.sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
    return rows[0];
};

/** 日盤與夜盤的結果中，取時間戳較新的那筆 */
export const pickFreshest = (candidates = []) => {
    const valid = candidates.filter(Boolean);
    if (!valid.length) return null;
    return valid.reduce((best, cur) => (cur.stamp > best.stamp ? cur : best));
};

/**
 * 優先採用日盤（一般交易時段）的那筆，沒有才退回夜盤。
 *
 * 用於每日快照：GitHub 的排程實測會延遲 1～2.5 小時，而期貨夜盤 15:00 就開始，
 * 若一律取「最新時段」，就會變成有些天記日盤收盤、有些天記夜盤盤中，
 * 使走勢圖與每月獲利統計混入不固定的夜盤波動。固定取日盤收盤，
 * 快照結果便與執行時間無關。
 *
 * 前端的「更新期貨價格」不適用這個規則 —— 那裡本來就該顯示當下最新的價格。
 */
export const pickDaySessionFirst = (candidates = []) => {
    const valid = candidates.filter(Boolean);
    if (!valid.length) return null;
    const day = valid.filter(c => c.session === 'day');
    return day.length ? day.reduce((b, c) => (c.stamp > b.stamp ? c : b)) : pickFreshest(valid);
};

/**
 * 期交所每日行情（開放資料）的挑選邏輯 —— 即時行情失敗時的退路。
 * 這份資料用 TradingSession 欄位區分「一般」與「盤後」。preferSession 預設 'night'
 * （盤後發生在後面，較新）；每日快照傳 'day' 以固定取日盤收盤，與即時行情的原則一致。
 * 注意這裡的契約代碼與即時行情不同：大台是 TX、小台 MTX、微台 TMF。
 */
/**
 * 鉅亨「近全」報價 —— 期交所即時行情不可用時的即時來源。
 *
 * 背景：期交所 mis.taifex.com.tw 會封鎖 Cloudflare Worker 的 IP（實測穩定 520，
 * 但同樣的 header 從家用網路直連為 200），導致前端只能退回每日行情，
 * 而那份資料落後一到兩個交易日。鉅亨可經由 Worker 存取且涵蓋日夜盤。
 *
 * 限制：只有指數期貨，且是「近全」（近月連續），不分契約月份；
 * 微台與個股期貨（CDF/QFF）皆無資料。因此僅作為期交所失敗時的備援。
 */
// 微台沒有自己的鉅亨報價，但它與小台追蹤同一個指數、同一契約月份。
// 實測同一時間戳的價差極小：日盤 7 點、夜盤 1 點（微台乘數 10 → 一口差 10～70 元）。
// 相較於「完全不更新而沿用舊價」動輒數千點的誤差，這個近似值明顯划算，
// 但仍標記 approx 讓介面標示出來，不假裝它是微台自己的成交價。
export const CNYES_SYMBOL = {
    TX:  { sym: 'TWF:TXF:FUTURES', approx: false },
    MTX: { sym: 'TWF:MXF:FUTURES', approx: false },
    TMF: { sym: 'TWF:MXF:FUTURES', approx: true }
};
export const cnyesEntry = (code) => CNYES_SYMBOL[String(code || '').toUpperCase()] || null;
export const cnyesUrl = (code) => {
    const e = cnyesEntry(code);
    return e ? `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${e.sym}` : null;
};
export const parseCnyesQuote = (json, approx = false) => {
    const q = (json && json.data && json.data[0]) || null;
    const price = q ? toNumber(q['6']) : null;
    if (!(price > 0)) return null;
    const change = toNumber(q['11']);
    return {
        price,
        prevClose: change === null ? price : price - change,
        session: 'unknown',
        nearContinuous: true,  // 近全報價，非特定契約月份
        approx                 // true 代表這是以相近商品替代的近似值
    };
};

export const OPEN_DATA_CONTRACT = { TX: 'TX', MTX: 'MTX', TMF: 'TMF', CDF: 'CDF', QFF: 'QFF' };

export const pickFromOpenData = (rows = [], contract, contractMonth = null, preferSession = 'night', maxAgeDays = 1) => {
    const mine = rows.filter(r => (r.Contract || '').trim() === contract);
    if (!mine.length) return null;
    const latest = mine.reduce((a, r) => (r.Date > a ? r.Date : a), '');
    // 這份是每日收盤資料，實測可能落後一到兩個交易日。太舊就回傳 null 讓呼叫端放棄。
    // 窗口刻意收得很緊（預設只接受今天或昨天）：曾發生 7/30 取到 7/28 的盤後價，
    // 與真實價差 2,780 點（大台一口 55 萬）。
    // 兩害相權：「沒更新」使用者看得到，「用舊價當現價」則會安靜地算錯損益。
    // 代價是週一開盤前這條退路會失效 —— 但那時本來就沒有新價格可用。
    if (!isWithinDays(latest, maxAgeDays)) return null;
    let sameDay = mine.filter(r => r.Date === latest);
    if (contractMonth) {
        const byMonth = sameDay.filter(r => r['ContractMonth(Week)'] === contractMonth);
        if (byMonth.length) sameDay = byMonth;
    } else {
        // 沒指定月份時排除週契約（月份欄位形如 202607W5）
        const monthly = sameDay.filter(r => !/W\d/.test(r['ContractMonth(Week)'] || ''));
        if (monthly.length) sameDay = monthly;
    }
    const valid = sameDay.filter(r => toNumber(r.Last) > 0);
    if (!valid.length) return null;
    // preferSession='day' 供每日快照使用，讓退路的取價原則與即時行情一致
    const wanted = preferSession === 'day' ? '一般' : '盤後';
    const pick = valid.find(r => r.TradingSession === wanted) || valid[0];
    const last = toNumber(pick.Last);
    const change = toNumber(pick.Change);
    return {
        price: last,
        prevClose: change === null ? last : last - change,
        session: pick.TradingSession === '盤後' ? 'night' : 'day',
        contractMonth: pick['ContractMonth(Week)'],
        sourceDate: latest,
        stale: true            // 這是每日收盤資料，不是即時報價
    };
};
