// 帳單到期提醒（排程版）
//
// 目的：卡片管家的「剩 N 天」只有在你主動打開網頁時才看得到。這支腳本每天早上
// 讀一次雲端的未繳帳單，只有在「有東西快到期」時才推一則 Telegram 訊息給你。
//
// 挑選與訊息組裝的邏輯在 bill-reminder-core.mjs（純函式，有回歸測試）。
// 這支只負責三件事：拿資料、叫它、把結果送出去。
//
// 需要的環境變數：
//   FIREBASE_SERVICE_ACCOUNT  Firebase 服務帳戶金鑰 JSON（整份貼上）—— 與每日快照共用
//   REMINDER_UID              要提醒的帳號 uid（只能一組）。APP_UID 只有一組時可以省略，
//                             會自動沿用；APP_UID 有多組時這個就是必填（理由見 core 的 pickUid）
//   TELEGRAM_BOT_TOKEN        跟 @BotFather 申請的 bot token
//   TELEGRAM_CHAT_ID          要推給誰（你自己跟 bot 說一句話之後就能查到）
//
// 選填：
//   REMIND_DAYS          到期前第幾天提醒，逗號分隔。預設 "3,1"。當天一律會提醒
//   OVERDUE_MAX_DAYS     逾期超過幾天就不再提醒。預設 60
//   REMIND_UNKNOWN_DATE  設 "false" 可關掉「繳款日不明」的提醒。預設開啟
//   REMINDER_DETAIL      "full"（預設，含金額與銀行）或 "counts"（只講筆數）
//   CARD_URL             訊息末尾附的卡片管家連結。預設為 GitHub Pages 上的網址
//   BILLBOT_WATCHDOG     設 "false" 關掉「帳單機器人沒在跑」的警告。預設開啟
//   BILLBOT_STALE_DAYS   機器人幾天沒動作就警告。預設 9（週排程 7 天 + 2 天寬限）
//   BILLBOT_MAX_DAYS     超過幾天就停止每天警告（可能是故意不用了）。預設 60
//   SNAPSHOT_WATCHDOG    設 "false" 關掉「每日快照筆電觸發中斷」的警告。預設開啟
//   SNAPSHOT_STALE_DAYS  筆電幾天沒觸發快照就警告。預設 3（日排程 1 天 + 2 天寬限）
//   SNAPSHOT_MAX_DAYS    超過幾天就停止每天警告。預設 60
//   IRIS_BOT_TOKEN       秘書「小艾」的 Telegram bot token；快照觸發看門狗警告只發給小艾，
//                        不發往帳單聊天室（保持帳單聊天室只有信用卡帳單相關訊息）
//   WATCHDOG_ONLY        設 "true" 只跑看門狗檢查，略過帳單到期提醒（供獨立雲端 watchdog.yml
//                        使用，確保筆電整台離線時雲端仍會巡邏心跳，且不會重複發送帳單提醒）
//   DRY_RUN              設 "true" 只檢查、不送出，日誌會多印「本來會送出幾行」
//   TEST_SEND            設 "true" 即使沒有帳單快到期也送一則測試訊息，用來確認
//                        token 與 chat id 真的通（平常沒事不送，否則無從驗證）
//
// ⚠️ 這個 repo 是公開的，GitHub Actions 的執行日誌任何人都看得到（不需登入）。
//    日誌只能印筆數與狀態 —— 推播訊息的內容、金額、銀行名稱、uid 一律不可以印。
//    DRY_RUN 也只印行數，不印內容。

import admin from 'firebase-admin';
import { selectBills, buildMessage, totalCount, pickUid, DEFAULT_REMIND_DAYS,
         DEFAULT_OVERDUE_MAX_DAYS, billbotStatus, buildBillbotAlert,
         DEFAULT_BILLBOT_STALE_DAYS, DEFAULT_BILLBOT_MAX_DAYS,
         snapshotDispatchStatus, buildSnapshotDispatchAlert,
         DEFAULT_DISPATCH_STALE_DAYS, DEFAULT_DISPATCH_MAX_DAYS } from './bill-reminder-core.mjs';
// 公開日誌不得出現 uid；錯誤訊息會帶含 uid 的文件路徑（理由見 log-redact.mjs 檔頭）
import { redactLog } from './log-redact.mjs';

const TZ = 'Asia/Taipei';
const DEFAULT_CARD_URL = 'https://chianghf99.github.io/my-wallet/mycreditcard.html';

const getTaipeiDate = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

const parseDays = (raw, fallback) => {
    if (!raw) return fallback;
    const list = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    return list.length ? list : fallback;
};

// Telegram sendMessage。
//
// 失敗要讓整支程式以非 0 離開 —— 「提醒沒送出去」必須在 Actions 上紅起來，
// GitHub 才會寄信通知。安靜地失敗等於這個功能從此不存在而你不知道。
const sendTelegram = async (token, chatId, text) => {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    if (!resp.ok) {
        // 回應內容可能帶回我們送出去的訊息，不可以整包印進公開日誌，只取狀態碼與
        // Telegram 給的錯誤描述（description 是固定字串，例如 "chat not found"）
        let desc = '';
        try { desc = (await resp.json())?.description || ''; } catch (e) { /* 非 JSON 就算了 */ }
        throw new Error(`Telegram 回應 HTTP ${resp.status}${desc ? `（${desc}）` : ''}`);
    }
};

const main = async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('缺少 FIREBASE_SERVICE_ACCOUNT 環境變數');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const dryRun = process.env.DRY_RUN === 'true';
    const testSend = process.env.TEST_SEND === 'true';
    const watchdogOnly = process.env.WATCHDOG_ONLY === 'true';
    if (!dryRun && (!token || !chatId)) {
        throw new Error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
    }

    const uid = pickUid(process.env.REMINDER_UID, process.env.APP_UID);
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    const db = admin.firestore();

    const snap = await db.collection('users').doc(uid).collection('creditcard').doc('data').get();
    if (!snap.exists) throw new Error('找不到卡片管家的資料文件');

    const data = snap.data() || {};
    const bills = Array.isArray(data.bills) ? data.bills : [];
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const cardUrl = process.env.CARD_URL || DEFAULT_CARD_URL;
    const today = getTaipeiDate();
    console.log(`讀到 ${bills.length} 筆帳單、${cards.length} 張卡片`);

    let groups = { overdue: [], dueToday: [], dueSoon: [], unknownDate: [] };
    if (watchdogOnly) {
        console.log('WATCHDOG_ONLY 模式：略過帳單到期提醒，只檢查看門狗');
    } else {
        groups = selectBills(bills, {
            today,
            cards,
            remindDays: parseDays(process.env.REMIND_DAYS, DEFAULT_REMIND_DAYS),
            overdueMaxDays: Number(process.env.OVERDUE_MAX_DAYS) || DEFAULT_OVERDUE_MAX_DAYS,
            remindUnknownDate: process.env.REMIND_UNKNOWN_DATE !== 'false',
        });

        // 只印筆數，不印金額、銀行與日期
        console.log(`逾期 ${groups.overdue.length}、今天到期 ${groups.dueToday.length}、`
            + `即將到期 ${groups.dueSoon.length}、繳款日不明 ${groups.unknownDate.length}`);
    }

    // 帳單機器人還活著嗎。這是獨立的一件事，所以也獨立成一則訊息 ——
    // 併進提醒裡的話，沒有帳單快到期的日子看門狗就跟著啞了，而那正是最需要它的時候。
    const watchdogOn = process.env.BILLBOT_WATCHDOG !== 'false';
    const bot = watchdogOn
        ? billbotStatus(data.billbot_heartbeat, Date.now(), {
            staleDays: Number(process.env.BILLBOT_STALE_DAYS) || DEFAULT_BILLBOT_STALE_DAYS,
            maxDays: Number(process.env.BILLBOT_MAX_DAYS) || DEFAULT_BILLBOT_MAX_DAYS,
        })
        : { state: 'off', days: null };
    console.log(`帳單機器人心跳：${bot.state}`
        + (bot.days === null ? '（雲端還沒有心跳欄位，看門狗尚未生效）' : `（${bot.days} 天前）`));

    const alert = buildBillbotAlert(bot, { url: cardUrl });

    // 每日快照的筆電發射器還活著嗎。
    // 取最近 65 筆 history 文件來看 dispatchedAt（上限預設 60 天，讀 65 筆已涵蓋整個有效區間）。
    // 若雲端還沒有任何一筆帶 dispatchedAt（還沒啟用筆電發射器），state 會是 'unknown'，安靜不警告。
    const snapWatchdogOn = process.env.SNAPSHOT_WATCHDOG !== 'false';
    let snapStatus = { state: 'off', days: null };
    if (snapWatchdogOn) {
        const histSnap = await db.collection('users').doc(uid).collection('history')
            .orderBy('date', 'desc')
            .limit(65)
            .get();
        const histDocs = histSnap.docs.map(d => d.data());
        snapStatus = snapshotDispatchStatus(histDocs, Date.now(), {
            staleDays: Number(process.env.SNAPSHOT_STALE_DAYS) || DEFAULT_DISPATCH_STALE_DAYS,
            maxDays: Number(process.env.SNAPSHOT_MAX_DAYS) || DEFAULT_DISPATCH_MAX_DAYS,
        });
    }
    console.log(`快照筆電觸發心跳：${snapStatus.state}`
        + (snapStatus.days === null ? '（雲端尚無外部觸發紀錄，看門狗尚未生效）' : `（${snapStatus.days} 天前）`));

    const snapAlert = buildSnapshotDispatchAlert(snapStatus);
    const hasBills = !watchdogOnly && totalCount(groups) > 0;

    if (!hasBills && !alert && !snapAlert && !(testSend && !watchdogOnly)) {
        console.log(watchdogOnly
            ? '看門狗檢查正常，不送出'
            : '今天沒有需要提醒的帳單，機器人與快照觸發也正常，不送出');
        return;
    }

    if (hasBills || (testSend && !watchdogOnly)) {
        const text = buildMessage(groups, {
            detail: process.env.REMINDER_DETAIL === 'counts' ? 'counts' : 'full',
            url: cardUrl,
            test: testSend,
        });
        if (dryRun) {
            console.log(`DRY_RUN：本來會送出一則 ${text.split('\n').length} 行的提醒（內容不印）`);
        } else {
            await sendTelegram(token, chatId, text);
            console.log('已送出提醒');
        }
    }

    if (alert) {
        if (dryRun) {
            console.log(`DRY_RUN：本來會送出一則看門狗警告（機器人 ${bot.days} 天沒動作）`);
        } else {
            await sendTelegram(token, chatId, alert);
            console.log('已送出看門狗警告');
        }
    }

    if (snapAlert) {
        const irisToken = (process.env.IRIS_BOT_TOKEN || '').trim();
        if (dryRun) {
            console.log(`DRY_RUN：本來會送出一則快照觸發看門狗警告給小艾（筆電 ${snapStatus.days} 天沒觸發）`);
        } else if (!irisToken) {
            console.log('未設定 IRIS_BOT_TOKEN，略過快照觸發看門狗推播（不發往帳單聊天室）');
        } else {
            await sendTelegram(irisToken, chatId, snapAlert);
            console.log('已送出快照觸發看門狗警告（小艾聊天室）');
        }
    }
};

main().catch(err => {
    // 同 snapshot.mjs：錯誤訊息可能帶含 uid 的 Firestore 文件路徑。
    // 這裡原本只印 err.message，但 message 本身就是會帶路徑的那一段。
    console.error('帳單提醒失敗：', redactLog(err));
    process.exit(1); // 讓 Actions 標記為失敗，GitHub 會寄信通知
});
