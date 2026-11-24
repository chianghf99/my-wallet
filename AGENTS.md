# My Wallet — 專案規範

個人資產與信用卡紀錄。純靜態網頁（Vue 3 CDN + Firebase），無建置流程，GitHub Pages 部署。

- `mystock.html` + `js/` — 資產紀錄帳本（股票／期貨／基金／房地產）
- `mycreditcard.html` — 卡片管家（單檔）
- `index.html` — 入口頁
- `scripts/` — 每日快照排程、帳單提醒、帳單機器人

> **這份檔案是規範的唯一本體，而且進版控。**
> Antigravity／Gemini 會自動讀 `AGENTS.md`；Claude Code 讀的 `CLAUDE.md` 只是一行
> `@` import 把這份帶進去。要改規範**只改這一個檔案**，不要在 `CLAUDE.md` 裡另寫一份。
> 也不要建 `GEMINI.md` —— 兩個入口並存就會開始各自飄移。
>
> 因為它會被 clone 到別的機器、被不同工具讀，所以**不要在這裡寫只對某一台機器為真的事**，
> 也不要寫會隨時間腐壞的數字或清單。詳見最後一節「不要寫會腐壞的事實」。

## 動手之前：先讀進度筆記

目前進度、未完成事項，以及一整節「開發環境的陷阱」在 **`.claude/progress.md`**。

那個檔案**超過 Antigravity 的單檔上限，所以不會自動載入**（硬塞會被從中間截斷，更危險）。
請在開始改 code 之前自己開來讀。它也**不進版控**（內容較敏感），所以在新 clone 的
機器上可能不存在 —— 不存在就直接問使用者，不要假設它的內容。

## 最容易踩的三件事

1. **不要把 `crypto-js` 升到 4.2.x。** 4.2.0 把 PBKDF2 的預設 hasher 從 SHA1 換成
   SHA256，而 `mycreditcard.html` 三處 PBKDF2 都沒指定 hasher —— 升版後金鑰全變、
   既有卡片（`enc_*` 欄位）與 `app_key_check` 全部解不開，而且不會有錯誤訊息，
   只會表現成「密碼錯誤」。

   **結論是「不要升」，不是「照步驟小心升」。** 4.2.0 修的 CVE-2023-46233 核心是
   「預設只跑 1 次迭代」，而這三處都明確傳了迭代次數，所以那個弱點對本專案不適用；
   剩下的差異只是 SHA1 當 PRF，在 PBKDF2 的用法下沒有實務破法。
   **收益趨近於零，代價是資料全毀。** 完整理由與真要升時的安全路徑寫在該檔的註解裡。

   ⚠️ **`test-card-crypto.mjs` 攔不住這件事，詳見「測試」那一節。**
2. **本機 server 必須用 port 8899。** Cloudflare Worker 的來源白名單只放行這個 port，
   換 port 會讓所有報價請求 CORS 失敗，看起來像程式壞了。
3. **改完 `js/*.js` 要換 port 重開 server。** 瀏覽器會快取 ES module，重新整理載不到新版。

## 執行環境

**先跑 `node -v` 確認這台機器有沒有 node。** 有就直接 `node scripts/test-*.mjs`，
語法檢查 `node --check js/main.js`。

沒有的話，macOS 的退路是內建的 `jsc`（不在 PATH 上，而且沒有 `console`，要自己墊一層）
—— 作法寫在 `.claude/progress.md` 的「開發環境的陷阱」那一節。

> 這一段刻意只寫查法不寫答案。2026-11-13～16 曾因為筆記裡寫死「這台機器沒有 node」
> 而整路繞 `jsc`，而那台機器其實早就裝了 node。環境類的斷言會從「當時為真」
> 安靜地變成「現在是錯的」。

## 排程跑在哪裡

- **每日資產快照**：GitHub Actions（`.github/workflows/daily-snapshot.yml`）。
  ⚠️ 實測延遲很嚴重、而且會跨過台北午夜造成走勢圖缺一天 —— 量到的數字、
  成因與修法都寫在那個檔案的註解裡，**動它之前先讀**。
- **帳單到期提醒**：GitHub Actions（`.github/workflows/bill-reminder.yml`），含看門狗；
  由 24 小時開機的 Windows PC 每天 08:30 透過 `scripts/trigger_bill_reminder.py` 以 `workflow_dispatch` 觸發（已停用 GitHub `schedule` 避免排程延遲與重複推播）。
- **帳單機器人**（`scripts/billbot`）：**一台 24 小時開機的 Windows PC**，不在開發機上。
  開發機（macOS）那側的排程、app、設定檔、帳本、記錄檔與 Keychain 憑證都已清除，
  **所以開發機不是回退路徑** —— 遇到問題方向是修 Windows，不要提議搬回去。
  平台差異在 `origin/billbot-windows` 分支上，還沒合併回 `main`。

## 不可違反的約束

- **`my-wallet` 是 public repo，Actions 日誌任何人都看得到。**
  `scripts/snapshot.mjs` 只能輸出筆數與狀態，**不得印出 uid、金額或持股代號**。
- **排程只處理 `APP_UID` 指定的帳號。** 要處理全部必須明確設定
  `SNAPSHOT_ALL_USERS=true`；這個開關刻意做成必須明寫，**不要把預設改成「全部」**。
- **升級 CDN 函式庫時 `integrity` 雜湊必須同步更新**，否則資源會被瀏覽器擋掉、整頁失效。

## 共用邏輯

估值（`js/utils/valuation.js`）與期貨取價（`js/utils/futures.js`）由**前端與排程共用同一份**。
改公式只需改一處；對應的測試會在 CI 寫入快照前驗證，未通過即中止。

## 測試

`scripts/test-*.mjs` 全部用 node 直接跑，另有 `scripts/billbot/test_bill_bot.py`。
**改到 `js/utils/` 底下任何共用邏輯，就把 `scripts/test-*.mjs` 全跑一遍**
（不要只跑你覺得相關的那幾支，CI 也是全跑）：

```bash
for f in scripts/test-*.mjs; do node "$f" || break; done
```

### `test-card-crypto.mjs` 守的是參數，不是函式庫版本

這支是黃金樣本測試，但它**刻意不載入 crypto-js** —— 它用 `node:crypto` 的
`pbkdf2Sync(..., 'sha1')` 獨立重算金鑰，再跟寫死的黃金值比對，而那個 `'sha1'`
是寫死在測試裡的。

所以它守得住的是：**網頁原始碼裡的金鑰參數（salt、迭代次數、canary 明文）沒被改掉。**
有人把迭代次數改掉，這裡會紅。

**它守不住的是：網頁實際載入的那版 crypto-js 行為變了。** 把 CDN 版本換成 4.2.x
之後這支測試照樣全綠，但瀏覽器端已經改用 SHA256 推金鑰、使用者的卡片解不開。
**那是個假綠燈，比沒有測試更糟。**

（2026-11-23 實測：讀完全部規範與進度筆記的代理仍然建議「跑過這支確認升版相容」，
所以這個誤解不是靠讀得仔細就能避免的，必須寫明。）

真要驗證函式庫升版相容，唯一可靠的方式是**在瀏覽器裡用新版實際推一次金鑰**，
與這支測試裡那組黃金值逐字比對 —— 那組值本來就是用網頁實際載入的那版產生的。

## 慣例

- commit 訊息寫「為什麼」而不只是「改了什麼」，並附上實測數據
- **但實測數據不得含個資**：金額、uid、持股代號、帳單檔名一律不寫進 commit 訊息。
  `my-wallet` 是 public repo，**commit 訊息要跟 Actions 日誌同等對待**
  （上面「不可違反的約束」那一條不只適用於 `snapshot.mjs`）。
  要證明測過，寫筆數、狀態、比例、相對關係就夠了：
  「新增 1 筆，bills 134 → 135」「較小者恰為較大者的 10.2%」可以，具體金額不行。
  2026-11-11 曾因為「附上實測數據」這條慣例而把真實帳單金額寫進兩個已推送的
  commit（`3d505d4`、`dd1d8fe`）—— 使用者決定不改寫歷史，但不要再發生。
- **`commit-msg` hook 會自動擋這件事**（貨幣金額、以「元」計價、28 碼 uid、PDF 檔名，
  外加 `.githooks/blocklist.local.txt` 裡的本機字詞）。
  **換機器或重新 clone 之後要跑一次 `git config core.hooksPath .githooks` 才會生效**
  —— 沒跑就等於沒有防護，而且不會有任何提示。細節見 `.githooks/README.md`。
  誤判時（公開行情、假設計算）用 `git commit --no-verify`。
- 決策理由寫進程式碼註解，不要只留在對話裡
- 版本號與更新日誌都在各自的 HTML 裡，改動時一併更新。
  **要確認目前版本，用 `curl` 對線上的 changelog**，不要相信筆記裡寫的版本號

## 不要寫會腐壞的事實

這份檔案、程式碼註解、`progress.md` 都適用。**凡是會隨時間或機器改變的數字與清單，
寫查法不要寫答案**：

| 不要寫 | 改成 |
|---|---|
| 「這台機器沒有 node」 | 「先跑 `node -v` 確認」 |
| 「progress.md 約 58 KB」 | 「超過 Antigravity 的單檔上限，不會自動載入」 |
| 逐支列出測試檔名 | 「`scripts/test-*.mjs` 全跑」 |
| 「資產帳本 v5.33.1」 | 「用 `curl` 對線上 changelog」 |
| 「延遲 67～151 分鐘」 | 附上重新量的指令 |

上表每一條都是真的發生過、而且真的誤導過接手的人。
