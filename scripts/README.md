# 排程任務

## 每日資產快照

`snapshot.mjs` 由 [`.github/workflows/daily-snapshot.yml`](../.github/workflows/daily-snapshot.yml)
在每個交易日 **14:37（台北）** 觸發，流程：

1. 抓匯率（失敗就整支中止，不寫入 —— 用預設匯率算出來的淨值會永久污染走勢圖）
2. 抓台股與美股報價（Yahoo v8 為主，台股另有 MIS 與官方收盤快照兩層退路）、期貨（期交所即時行情，日盤與夜盤取較新者；退路為期交所每日行情），並寫回 Firestore
3. 依 `js/utils/valuation.js`（與前端共用）算出淨資產、槓桿、曝險等指標
4. 寫入 `users/{uid}/history/{YYYY-MM-DD}`，並標記 `source: 'scheduled'`

### 為什麼固定取日盤

**期貨固定採用日盤收盤價**：夜盤 15:00 就開始，若取「最新時段」，
延遲到 17:00 之後執行的那幾天就會記到夜盤盤中價，使歷史數列失去可比性。
固定取日盤後，快照結果與實際執行時間無關。前端的「更新期貨價格」不受此限制。

GitHub 的排程不保證準時：實測設在 06:30 UTC 那次完全未觸發，改用零散分鐘數
（06:37 UTC）後才穩定，實測延遲 67～151 分鐘但都有執行。由於取價已與執行
時間脫鉤，一天一次即足夠；若日後又出現漏跑，加一行較晚的 cron 當保險即可
（重複執行只會以較新報價覆蓋同一份文件）。

台股 13:30 收盤、期貨一般交易時段 13:45 收盤，抓到的是當日確定的收盤價。
美股當時尚未開盤（美東 02:30），因此每日快照中的美股部位會是**前一交易日**收盤價 —— 這是台股收盤快照的必然結果。

### 需要的 GitHub Secrets

| 名稱 | 內容 | 必填 |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase 服務帳戶金鑰 JSON（整份貼上） | ✅ |
| `FINNHUB_API_KEY` | 美股備援報價金鑰 | 選填 |
| `APP_UID` | 要快照的帳號 uid，多組以逗號分隔 | ✅ |
| `SNAPSHOT_ALL_USERS` | 設為 `true` 才會處理專案下所有帳號 | 選填 |

### ⚠️ 日誌是公開的

`my-wallet` 是 public repo，GitHub Actions 的執行日誌**任何人都能查看，不需登入**。
因此 `snapshot.mjs` 只會輸出筆數與狀態，**不得印出 uid、金額或持股代號**。
日後修改日誌時請務必維持這個原則。

### ⚠️ 不要在未明示的情況下處理他人帳號

這個 Firebase 專案可能有其他人的帳號（別人也用這個網頁登入過）。排程跑的是專案擁有者的
管理金鑰與 API 額度，因此預設只處理 `APP_UID` 指定的帳號；要處理全部必須明確設定
`SNAPSHOT_ALL_USERS=true`。

### 為什麼美股不用 Finnhub 當主力

Finnhub 免費版會封鎖資料中心 IP。同一把金鑰從家用網路可正常取得報價，
從 GitHub Actions 的機器則 **100% 失敗** —— 這是排程曾出現「美股全滅、台股 0 失敗」的原因。
Yahoo v8 沒有這個限制、不需金鑰、無次數限制，實測報價與 Finnhub 完全一致，故改為主要來源，
Finnhub 僅保留為退路。

### 注意事項

- 估值邏輯（`js/utils/valuation.js`）與期貨取價邏輯（`js/utils/futures.js`）皆與前端**共用同一份**，改動只需一處；`scripts/test-valuation.mjs` 與 `test-futures.mjs` 會在寫入快照前於 CI 驗證。
- `test-card-crypto.mjs` 是卡片管家加解密的黃金樣本測試，守的是「既有加密資料還解得開」：
  它直接從 `mycreditcard.html` 抽出金鑰參數（固定 salt、PBKDF2 迭代次數、canary 明文）確認沒被改動，
  再用 Node 內建 crypto 獨立重算金鑰、解開寫死的密文。改錯這些不會當場報錯，
  而是等到換裝置登入才發現資料解不開，所以需要自動化把關。
- 三支測試都只用 Node 內建模組（不需 `npm install`），並由 `.github/workflows/tests.yml` 在每次推上 `main` 與 PR 時執行。
- GitHub Actions 的 cron 不保證準時（實測延遲 1～2.5 小時）；因期貨固定取日盤收盤，對快照結果沒有影響。
- 國定假日休市時會照跑，抓到的是前一交易日收盤價，等於複製前一天的快照，走勢圖呈現持平，不影響正確性。
- 可在 Actions 頁面用 **Run workflow** 手動觸發測試。

---

## 帳單到期提醒

`bill-reminder.mjs` 由 [`.github/workflows/bill-reminder.yml`](../.github/workflows/bill-reminder.yml)
每天 **07:47（台北）** 觸發，讀雲端的未繳帳單，**只有在有東西快到期時**才推一則
Telegram 訊息。沒事就安靜，不會每天都來。

提醒時機：

| 狀況 | 會不會提醒 |
|---|---|
| 繳款日前 3 天、前 1 天 | ✅ 各一次（`REMIND_DAYS` 可改） |
| 繳款日當天 | ✅ 一定提醒，不受設定影響 |
| 已逾期 | ✅ 每天，直到逾期滿 60 天為止 |
| 繳款日不明（PDF 沒解析出日期） | ✅ 每天，直到你補上日期或標為已繳 |
| 已繳 / 跳過 / 金額為 0 | ❌ |

### 設定步驟（約五分鐘）

**1. 建 bot，拿 token**

在 Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 照著取名字 →
它會回一串 `123456789:AAE...` 的 token。

**2. 跟你的 bot 講一句話**

搜尋剛才取的 bot 名稱，點進去按「開始」隨便傳一個字。
**不傳這一句，bot 不能主動發訊息給你**（Telegram 的規則）。

**3. 查你的 chat id**

瀏覽器打開（把 `<TOKEN>` 換成第 1 步那串）：

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

回應裡 `"chat":{"id":123456789,...}` 的那個數字就是 `TELEGRAM_CHAT_ID`。

**4. 填進 GitHub Secrets**

repo → Settings → Secrets and variables → Actions → New repository secret：

| 名稱 | 內容 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | 第 1 步那串 token |
| `TELEGRAM_CHAT_ID` | 第 3 步那個數字 |

`FIREBASE_SERVICE_ACCOUNT` 與 `APP_UID` 沿用每日快照的那兩個，不必重設。

**如果 `APP_UID` 裡有多組 uid**（逗號分隔，每日快照會處理多個帳號），還要再加一個：

| 名稱 | 內容 |
|---|---|
| `REMINDER_UID` | **要收提醒的那一組** uid，只能一組 |

沒設的話排程會直接中止並說明原因 —— 它不會替你猜要提醒誰（理由見下面那節）。
`APP_UID` 不用動，每日快照仍然照舊處理全部帳號。

查自己的 uid：[Firebase Console](https://console.firebase.google.com/) → 選這個專案 →
左邊 **Authentication** → **Users** 分頁 → 找到自己的 email，那一列的
**User UID** 就是。用 email 對照才不會挑錯人。

**5. 試跑**

Actions → 帳單到期提醒 → Run workflow，有兩個勾選框：

| 勾選 | 作用 |
|---|---|
| **只檢查不送出**（`dry_run`） | 日誌印出有幾筆符合條件，不發訊息 |
| **測試送出**（`test_send`） | **就算現在沒有帳單快到期也發一則**，確認 Telegram 真的通 |

建議順序：先跑 `dry_run` 看筆數合不合理 → 再跑 `test_send` 確認手機真的收到 →
之後就交給排程。

`test_send` 存在的理由見下面「為什麼需要測試送出」。

### 為什麼需要測試送出

平常沒有帳單快到期時這支腳本什麼都不送 —— 這是刻意的，否則通知會變成雜訊。
但副作用是「token 與 chat id 到底對不對」要等到真有帳單快到期那天才知道。

更麻煩的是：**chat id 如果指向另一個對話**（例如抓錯了一組數字），Telegram 會
回 200、Actions 會顯示綠色、訊息卻送到你看不到的地方。這是這個功能**唯一一種
安靜的失敗**，其他錯誤（token 錯、secret 沒設、Firestore 讀不到）都會讓 Actions
變紅並寄信通知你。`test_send` 就是把這一種也變成吵的。

### 想改設定看這裡

全部是選填的環境變數，加在 `bill-reminder.yml` 最後一步的 `env:` 底下。

| 想做的事 | 設定 |
|---|---|
| 改提醒時機（例如提前一週） | `REMIND_DAYS: '7,3,1'` |
| 逾期多久就別再吵 | `OVERDUE_MAX_DAYS: '30'` |
| 關掉「繳款日不明」的提醒 | `REMIND_UNKNOWN_DATE: 'false'` |
| 訊息不要有金額與銀行名稱 | `REMINDER_DETAIL: 'counts'` |
| 改訊息末尾的連結 | `CARD_URL: 'https://...'` |
| 改推播時間 | 改 workflow 裡的 `cron`（UTC，台北要減 8 小時） |

### ⚠️ 推播內容會經過 Telegram 的伺服器

預設的 `full` 模式會送出**銀行名稱、金額、繳款日**。這是你自己跟自己 bot 的私人對話，
但訊息確實會經過 Telegram。不想送出這些就設 `REMINDER_DETAIL: 'counts'`，
訊息會變成「你有 3 筆未繳帳單需要注意：已逾期 1 筆、今天最後一天 1 筆……」，
金額與銀行完全不出境。

**自動扣款帳戶末五碼（`card.autopayFrom`）在任何模式下都不會進訊息** ——
訊息只會標一個「🏦 自動扣繳」。這條有測試釘住（`test-bill-reminder.mjs`）。

同樣地，Actions 日誌只會印筆數與狀態，不印訊息內容、金額、銀行或 uid；
`DRY_RUN` 也只印「本來會送出幾行」，不印內容。

### 為什麼提醒只收一組 uid

每日快照可以一次處理多個帳號，因為它是各寫各的資料庫。提醒不行 ——
它只有一個 Telegram 收件人，多組 uid 會把**別人的帳單金額推到你的手機上**。

所以取 uid 的順序是：先看 `REMINDER_UID`；沒設的話，只有在 `APP_UID` 剛好只有
一組、不會有歧義時才沿用它。`APP_UID` 有多組而 `REMINDER_UID` 沒設就直接中止，
**不猜**。

這條在第一次試跑時就擋下來過一次（`APP_UID` 本來就有多組），所以 `pickUid`
放在 core 裡並有測試覆蓋，包含「錯誤訊息必須提到 `REMINDER_UID`」這一條 ——
失敗訊息不告訴人怎麼修，等於沒擋。

### 為什麼挑選邏輯要獨立成一個檔案

`bill-reminder-core.mjs` 是純函式、不碰網路也不碰 Firestore，由
`test-bill-reminder.mjs` 覆蓋。原因是這個功能的失敗模式是**安靜的**：
提醒不會噴錯，它只是沒出現，或是把天數算錯一天，等到發現時帳單已經逾期了。

天數算法的坑特別值得記一筆：`new Date('2026-11-12')` 會被解讀成 **UTC 午夜**，
拿它減「本地午夜」在台北（UTC+8）會差 8 小時，`Math.ceil` 之後整個倒數多出一天。
網頁的「剩 N 天」原本就是這樣算的（v5.15.0 已修，兩邊現在用同一套算法）。
