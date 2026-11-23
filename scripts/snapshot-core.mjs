// 每日資產快照 —— 日期歸屬與寫入欄位組裝（純函式，不碰網路也不碰 Firestore）
//
// 為什麼單獨抽一個檔案：
// snapshot.mjs 會 import firebase-admin，而測試需要只靠 Node 內建模組就能跑。
// 把「這份快照該歸在哪一天」與「哪些觸發資訊該寫進文件」抽成純函式，才能在 CI
// 與寫入快照前先跑回歸測試（見 test-snapshot.mjs）。
//
// 核心問題（2026-11-22 實測發現）：
// GitHub Actions 的 schedule 排程在 14:37（台北）觸發，但實測延遲中位數達 7～9.9 小時，
// 最大 12.3 小時（跨過台北午夜，落到隔天 02:58）。舊版直接拿執行當下的日曆日當 key，
// 一旦跨過午夜，那天的收盤資料就會被寫到隔天那份文件上 —— 結果前一天完全沒有快照
// （走勢圖缺一天），隔天被寫兩次。同樣地，本機工作排程器的「錯過排程後盡快執行」
// 若在隔天早上 09:00 開機時補跑，拿到的也是前一交易日的收盤價。

const TZ = 'Asia/Taipei';

// 台股 13:30 收盤、期貨日盤 13:45 收盤，排程定在 14:35～14:37。
// 任何在台北時間 14:00 之前執行的排程快照，拿到的必然是「前一天」的收盤價。
export const SNAPSHOT_CUTOFF_HOUR = 14;

// 'YYYY-MM-DD' → UTC 午夜毫秒數；格式不對或日期不存在（如 2026-02-30）回 null。
export const parseYMD = (s) => {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const [, y, mo, d] = m.map(Number);
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
};

// 對 'YYYY-MM-DD' 加減整數天，回傳新的 'YYYY-MM-DD'（純 UTC 日曆運算，不受時區與日光節約影響）。
export const shiftDate = (ymd, deltaDays) => {
    const ms = parseYMD(ymd);
    if (ms === null || !Number.isFinite(deltaDays)) return null;
    const d = new Date(ms + Math.trunc(deltaDays) * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// 把任意時間點（Date 或毫秒數）轉成台北時區的 { date: 'YYYY-MM-DD', hour: 0..23 }
export const getTaipeiClock = (now = new Date()) => {
    const d = now instanceof Date ? now : new Date(now);
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
    // en-GB 的 2-digit hour12:false 在午夜回 '00'（部分環境的 h23/24-hour 會回 '24'，這裡 % 24 防呆）
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour: '2-digit', hour12: false
    }).format(d)) % 24;
    return { date, hour };
};

/**
 * 決定這一次排程執行代表哪一天的收盤快照。
 *
 * 規則：
 *   1. 若有明確指定 targetDate（例如環境變數 TARGET_DATE 補跑特定日期），驗證格式後直接採用；
 *      若 targetDate 非空但格式不合法，直接丟例外中止，不默默退回今天（避免補跑打錯字卻覆蓋到今天）。
 *   2. 否則看台北時間的小時：
 *      - hour >= 14（預設門檻）：當天日盤已收盤，歸屬今天（shifted: false）
 *      - hour < 14：當天日盤還沒收盤，這必然是前一天遲到（跨過午夜）或隔天早上開機補跑的排程，
 *        歸屬前一天（shifted: true）
 *
 * @param {object} [opts]
 * @param {Date|number} [opts.now]          執行當下的時間（預設 new Date()）
 * @param {string}      [opts.wallDate]     直接指定台北日曆日 'YYYY-MM-DD'（測試用，優先於 now）
 * @param {number}      [opts.hour]         直接指定台北小時 0..23（測試用，優先於 now）
 * @param {string}      [opts.targetDate]   手動覆寫的目標日期（對應 TARGET_DATE）
 * @param {number}      [opts.cutoffHour]   收盤門檻小時，預設 14
 * @returns {{ date: string, wallDate: string, savedHour: number, shifted: boolean, overridden: boolean }}
 */
export const resolveSnapshotDate = (opts = {}) => {
    const cutoff = Number.isFinite(opts.cutoffHour) ? opts.cutoffHour : SNAPSHOT_CUTOFF_HOUR;
    const clock = (opts.wallDate !== undefined && opts.hour !== undefined)
        ? { date: String(opts.wallDate).trim(), hour: Number(opts.hour) }
        : getTaipeiClock(opts.now);

    if (parseYMD(clock.date) === null || !Number.isFinite(clock.hour) || clock.hour < 0 || clock.hour > 23) {
        throw new Error(`無效的台北時間：date=${clock.date}, hour=${clock.hour}`);
    }

    const rawTarget = opts.targetDate !== undefined && opts.targetDate !== null
        ? String(opts.targetDate).trim()
        : '';
    if (rawTarget) {
        if (parseYMD(rawTarget) === null) {
            throw new Error(`TARGET_DATE 格式不正確（應為 YYYY-MM-DD）：${rawTarget}`);
        }
        return {
            date: rawTarget,
            wallDate: clock.date,
            savedHour: clock.hour,
            shifted: false,
            overridden: true,
        };
    }

    if (clock.hour < cutoff) {
        return {
            date: shiftDate(clock.date, -1),
            wallDate: clock.date,
            savedHour: clock.hour,
            shifted: true,
            overridden: false,
        };
    }

    return {
        date: clock.date,
        wallDate: clock.date,
        savedHour: clock.hour,
        shifted: false,
        overridden: false,
    };
};

/**
 * 正規化觸發來源名稱（對應 GitHub Actions 的 GITHUB_EVENT_NAME）。
 *
 * 為什麼不改寫既有的 source: 'scheduled'：
 * 前端 js/main.js:289 用 `r.savedHour === undefined && r.source === undefined` 來判斷
 * 「這筆歷史紀錄是不是人工手動校正過的」。source 代表的是「寫入管道（排程 vs 前端）」，
 * 而「這趟排程是 GitHub cron 還是外部 workflow_dispatch 喚醒的」是另一個維度，
 * 因此獨立放在 trigger 欄位。
 */
export const normalizeTrigger = (eventName) => {
    const s = String(eventName || '').trim();
    return s || 'manual';
};

/**
 * 組裝每日快照寫入 history/{date} 的控制中繼欄位。
 *
 * ⚠️ 為什麼 dispatchedAt 只在 workflow_dispatch 時才帶入物件（schedule 時連 key 都不能有）：
 * 我們刻意保留 GitHub 自己的 schedule cron 作為筆電死掉時的保底，而且不跳過已存在的快照
 * （讓較晚執行的那次可以用最新報價自我修復早上的瞬斷舊價）。
 *
 * 但因為 snapshot.mjs 用的是 `.set(doc, { merge: true })`：
 *   1. 14:35 筆電發 workflow_dispatch → 寫入 trigger: 'workflow_dispatch', dispatchedAt: 1763...
 *   2. 22:50 GitHub 的 schedule 醒來覆寫同一份文件 → trigger 會被改成 'schedule'！
 * 如果看門狗只看 trigger 欄位，每天晚上都會被 schedule 洗掉，隔天早上看門狗就會誤判
 * 「筆電死了」而天天發假警報。
 *
 * 解法：只在 trigger === 'workflow_dispatch' 時寫入 dispatchedAt（毫秒時戳）。
 * 晚上 schedule 執行時回傳的物件**不含 dispatchedAt 這個 key**，在 `{ merge: true }` 下
 * Firestore 會原封不動保留 14:35 寫進去的 dispatchedAt。看門狗只要檢查 dispatchedAt，
 * 就能同時享有「二次執行自我修復報價」與「精準知道筆電今天有沒有準時發訊號」。
 *
 * @param {object} opts
 * @param {string} opts.date
 * @param {number} opts.savedHour
 * @param {string} [opts.eventName]  process.env.GITHUB_EVENT_NAME
 * @param {number} [opts.nowMs]      Date.now()
 */
export const buildSnapshotMeta = ({ date, savedHour, eventName, nowMs = Date.now() }) => {
    const trigger = normalizeTrigger(eventName);
    const meta = {
        date,
        savedHour,
        source: 'scheduled',
        trigger,
    };
    if (trigger === 'workflow_dispatch') {
        meta.dispatchedAt = nowMs;
    }
    return meta;
};
