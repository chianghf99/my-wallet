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
//   DRY_RUN              設 "true" 只檢查、不送出，日誌會多印「本來會送出幾行」
//   TEST_SEND            設 "true" 即使沒有帳單快到期也送一則測試訊息，用來確認
//                        token 與 chat id 真的通（平常沒事不送，否則無從驗證）
//
// ⚠️ 這個 repo 是公開的，GitHub Actions 的執行日誌任何人都看得到（不需登入）。
//    日誌只能印筆數與狀態 —— 推播訊息的內容、金額、銀行名稱、uid 一律不可以印。
//    DRY_RUN 也只印行數，不印內容。

import admin from 'firebase-admin';
import { selectBills, buildMessage, totalCount, pickUid, DEFAULT_REMIND_DAYS,
         DEFAULT_OVERDUE_MAX_DAYS } from './bill-reminder-core.mjs';

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
    const today = getTaipeiDate();
    console.log(`讀到 ${bills.length} 筆帳單、${cards.length} 張卡片`);

    const groups = selectBills(bills, {
        today,
        cards,
        remindDays: parseDays(process.env.REMIND_DAYS, DEFAULT_REMIND_DAYS),
        overdueMaxDays: Number(process.env.OVERDUE_MAX_DAYS) || DEFAULT_OVERDUE_MAX_DAYS,
        remindUnknownDate: process.env.REMIND_UNKNOWN_DATE !== 'false',
    });

    // 只印筆數，不印金額、銀行與日期
    console.log(`逾期 ${groups.overdue.length}、今天到期 ${groups.dueToday.length}、`
        + `即將到期 ${groups.dueSoon.length}、繳款日不明 ${groups.unknownDate.length}`);

    if (totalCount(groups) === 0 && !testSend) {
        console.log('今天沒有需要提醒的帳單，不送出');
        return;
    }

    const text = buildMessage(groups, {
        detail: process.env.REMINDER_DETAIL === 'counts' ? 'counts' : 'full',
        url: process.env.CARD_URL || DEFAULT_CARD_URL,
        test: testSend,
    });

    if (dryRun) {
        console.log(`DRY_RUN：本來會送出一則 ${text.split('\n').length} 行的訊息（內容不印）`);
        return;
    }

    await sendTelegram(token, chatId, text);
    console.log('已送出提醒');
};

main().catch(err => {
    console.error('帳單提醒失敗：', err.message);
    process.exit(1); // 讓 Actions 標記為失敗，GitHub 會寄信通知
});
