// 帳單到期提醒 —— 挑選與訊息組裝（純函式，不碰網路也不碰 Firestore）
//
// 為什麼單獨切一個檔案：bill-reminder.mjs 會 import firebase-admin，而開發機沒有
// node，jsc 跑不動它。把「要提醒哪幾筆、訊息長什麼樣」這段純邏輯獨立出來，本機
// 才能用 jsc 跑回歸測試（見 test-bill-reminder.mjs）。這段邏輯錯掉不會有任何徵兆
// —— 提醒不會爆炸，它只是安靜地不出現，或是把日期算錯一天 —— 所以一定要有測試。
//
// ⚠️ 這個 repo 是公開的。這個檔案只負責「組字串」，組好的字串只會送進 Telegram，
//    絕對不可以 console.log 出來（Actions 日誌任何人都看得到）。

// 預設在到期前第 3 天與第 1 天各提醒一次。
// 為什麼不是「三天內天天提醒」：連續三天收到同一則通知，第二天起就會被當成雜訊
// 滑掉，真正緊急的「今天最後一天」反而被埋掉。當天（第 0 天）一律會提醒，不受
// 這個設定影響。
export const DEFAULT_REMIND_DAYS = [3, 1];

// 逾期超過這個天數就不再提醒。
// 為什麼要有上限：一筆兩年前忘了標「已繳」的帳單，不是待辦事項而是資料沒整理，
// 讓它每天跳出來只會讓人開始忽略整個通知。
export const DEFAULT_OVERDUE_MAX_DAYS = 60;

// 'YYYY-MM-DD' → UTC 午夜的毫秒數；格式不對或日期不存在都回 null。
//
// 為什麼堅持自己拆字串，不用 new Date(s)：
// new Date('2026-11-12') 會被解讀成 UTC 午夜，拿它跟「本地的今天」相減，在台北
// （UTC+8）會差 8 小時，Math.ceil 之後整個倒數就多出一天。網頁上的「剩 N 天」
// 正是踩到這個坑（v5.15.0 已修）。兩邊都換算成 UTC 午夜就不會有時區問題。
export const parseYMD = (s) => {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
    if (!m) return null;
    const [, y, mo, d] = m.map(Number);
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    // 擋掉 2026-02-30 這種「格式對、日期不存在」的字串 —— Date.UTC 會默默進位成 3/2
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
};

// 距離到期還有幾天。今天到期回 0，昨天到期回 -1。算不出來回 null。
export const daysUntil = (dateStr, todayStr) => {
    const due = parseYMD(dateStr);
    const today = parseYMD(todayStr);
    if (due === null || today === null) return null;
    // 兩邊都是 UTC 午夜，相減必為整日，不會有日光節約或時區的零頭
    return Math.round((due - today) / 86400000);
};

// 這張帳單對應的卡片有沒有設自動扣繳。
//
// 比對方式刻意與網頁的 getCardAutopay 一字不差（卡片名稱是帳單名稱的子字串），
// 兩邊判斷不一致會比沒有這個標記更糟。
//
// ⚠️ 只回傳 true/false。card.autopayFrom 存的是扣款帳戶末五碼，那是個資，
//    絕對不可以放進推播訊息 —— 訊息會經過 Telegram 的伺服器。
export const hasAutopay = (billName, cards) => {
    if (!billName || !Array.isArray(cards)) return false;
    const c = cards.find(c => c && c.name && billName.includes(c.name));
    return Boolean(c && c.autopayFrom);
};

// 未繳＝不是 paid 也不是 skipped。
//
// 網頁的未繳清單寫的是 status === 'unpaid'，這裡比它寬。理由是兩種漏判的代價不對稱：
// 多提醒一筆只是吵，漏提醒一筆是真的沒繳到錢。實務上寫入端（網頁與 billbot）都會
// 明確帶 status，這個差異只在資料異常時才會顯現。
const isUnpaid = (b) => b && b.status !== 'paid' && b.status !== 'skipped';

/**
 * 從整包帳單裡挑出今天該提醒的。
 *
 * @param {object[]} bills  Firestore 的 bills 陣列
 * @param {object}   opts
 * @param {string}   opts.today           'YYYY-MM-DD'（台北時區的今天）
 * @param {object[]} [opts.cards]         卡片陣列，只用來判斷有無自動扣繳
 * @param {number[]} [opts.remindDays]    到期前第幾天要提醒
 * @param {number}   [opts.overdueMaxDays] 逾期超過幾天就不再提醒
 * @param {boolean}  [opts.remindUnknownDate] 繳款日不明的未繳帳單要不要提醒
 */
export const selectBills = (bills, opts = {}) => {
    const {
        today,
        cards = [],
        remindDays = DEFAULT_REMIND_DAYS,
        overdueMaxDays = DEFAULT_OVERDUE_MAX_DAYS,
        remindUnknownDate = true,
    } = opts;

    const out = { overdue: [], dueToday: [], dueSoon: [], unknownDate: [] };
    if (!Array.isArray(bills) || parseYMD(today) === null) return out;

    const wanted = new Set((remindDays || []).map(Number).filter(n => Number.isFinite(n) && n > 0));

    for (const b of bills) {
        if (!isUnpaid(b)) continue;

        // 金額為 0 的帳單沒有東西要繳（華南上期溢繳就會記成 0），不必提醒
        const amount = Number(b.amount) || 0;
        if (amount <= 0) continue;

        const entry = { name: b.name || '未命名帳單', amount, date: b.date, autopay: hasAutopay(b.name, cards) };
        const d = daysUntil(b.date, today);

        if (d === null) {
            // 繳款日不明。這一條會每天提醒到被處理為止，而且是故意的 ——
            // 一筆不知道何時到期的未繳帳單，沉默遠比吵鬧危險。
            // 真的不想看到就把 REMIND_UNKNOWN_DATE 設成 false。
            if (remindUnknownDate) out.unknownDate.push(entry);
        } else if (d < 0) {
            if (-d <= overdueMaxDays) out.overdue.push({ ...entry, days: d });
        } else if (d === 0) {
            out.dueToday.push({ ...entry, days: 0 });
        } else if (wanted.has(d)) {
            out.dueSoon.push({ ...entry, days: d });
        }
    }

    // 急的排前面
    out.overdue.sort((a, b) => a.days - b.days);
    out.dueSoon.sort((a, b) => a.days - b.days);
    return out;
};

export const totalCount = (g) =>
    g.overdue.length + g.dueToday.length + g.dueSoon.length + g.unknownDate.length;

// --- 訊息組裝 -------------------------------------------------------------

const money = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const mmdd = (dateStr) => {
    const ms = parseYMD(dateStr);
    if (ms === null) return '';
    const d = new Date(ms);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

// Telegram 的 parse_mode: 'HTML' 只認這三個字元需要跳脫
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const line = (e) => `• ${esc(e.name)}　<b>${money(e.amount)}</b>${e.autopay ? '　🏦 自動扣繳' : ''}`;

// 依剩餘天數分組，回傳 [[天數, 該天的帳單], ...]，天數由小到大
const groupByDay = (list) => {
    const m = new Map();
    for (const e of list) {
        if (!m.has(e.days)) m.set(e.days, []);
        m.get(e.days).push(e);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
};

/**
 * 把挑出來的帳單組成推播訊息。沒有東西要提醒就回 null（代表今天不發）。
 *
 * @param {object} groups  selectBills 的輸出
 * @param {object} [opts]
 * @param {'full'|'counts'} [opts.detail]  'counts' 只講筆數，金額與銀行不出境
 * @param {string} [opts.url]              訊息末尾附的卡片管家連結
 */
export const buildMessage = (groups, opts = {}) => {
    const { detail = 'full', url = '' } = opts;
    if (totalCount(groups) === 0) return null;

    const parts = ['💳 <b>帳單提醒</b>'];

    if (detail === 'counts') {
        // 隱私模式：訊息會經過 Telegram 的伺服器，這個模式下金額與銀行名稱都不送出去
        const bits = [];
        if (groups.overdue.length) bits.push(`已逾期 ${groups.overdue.length} 筆`);
        if (groups.dueToday.length) bits.push(`今天最後一天 ${groups.dueToday.length} 筆`);
        for (const [d, list] of groupByDay(groups.dueSoon)) bits.push(`還有 ${d} 天 ${list.length} 筆`);
        if (groups.unknownDate.length) bits.push(`繳款日不明 ${groups.unknownDate.length} 筆`);
        parts.push('', `你有 ${totalCount(groups)} 筆未繳帳單需要注意：`, ...bits.map(b => `• ${b}`));
    } else {
        if (groups.overdue.length) {
            parts.push('', '🔴 <b>已逾期</b>');
            for (const e of groups.overdue) parts.push(`${line(e)}　（${mmdd(e.date)}，逾期 ${-e.days} 天）`);
        }
        if (groups.dueToday.length) {
            parts.push('', '⚠️ <b>今天最後一天</b>');
            for (const e of groups.dueToday) parts.push(line(e));
        }
        // 同一天到期的併成一段，不要每筆各開一個標題
        for (const [d, list] of groupByDay(groups.dueSoon)) {
            parts.push('', `📅 <b>還有 ${d} 天</b>（${mmdd(list[0].date)}）`);
            for (const e of list) parts.push(line(e));
        }
        if (groups.unknownDate.length) {
            parts.push('', '❓ <b>繳款日不明，請到卡片管家補上</b>');
            for (const e of groups.unknownDate) parts.push(line(e));
        }
    }

    if (url) parts.push('', esc(url));
    return parts.join('\n');
};
