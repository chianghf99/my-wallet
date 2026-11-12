# 帳單機器人（本機排程）

你每個月唯一要做的事：**把帳單 PDF 從電子信箱下載到指定資料夾**。
其餘由排程完成 —— 解開 PDF 密碼、解析銀行／金額／繳款截止日、寫進卡片管家的雲端資料。

```
電子信箱 →（你手動下載）→ 09_其他/電子郵件附件/
                              ↓ 每週日 12:00（launchd）
                          bill_bot.py
                              ├─ pdfplumber 解開密碼並取出版面文字
                              ├─ jsc 執行 js/utils/bill-parse.js（與網頁同一份規則）
                              └─ Firestore REST 寫入 users/{uid}/creditcard/data 的 bills
                                                        ↓
                                               卡片管家網頁直接看得到
```

## 為什麼是這樣設計

| 決定 | 理由 |
|---|---|
| 解析規則與網頁**共用同一份** | 13 家銀行的規則抽到 `js/utils/bill-parse.js`，兩邊都用它。另寫一份 Python 的代價是「改了網頁沒改排程」時排程會默默算出錯的金額，而且不會有任何徵兆。與 `valuation.js`／`futures.js` 的處理方式一致。 |
| 用 `jsc` 而不是 node | 這台機器沒有 node。macOS 內建 JavaScriptCore，古典 script 在瀏覽器與 jsc 都載得動。 |
| 寫 **Firestore**，不是 commit 進 repo | 卡片管家的資料在 `users/{uid}/creditcard/data`，網頁只是讀它。`my-wallet` 是 public repo，帳單金額 commit 進去等於公開。 |
| 用**機器人專用帳號**，不用服務帳戶金鑰 | 服務帳戶金鑰是整個 Firebase 專案的管理權，而這個專案裡有其他使用者的帳號。機器人帳號靠 Firestore 規則限制在「只能動你那一份文件」，硬碟上也不留金鑰檔。 |
| 密碼放 **Keychain** | 不進設定檔、不進版控、不留在 shell 歷史。執行當下才讀。 |
| 只動 `bills` 欄位 | 用 Firestore 的 `updateMask`，`cards`、`app_key_salt`、`app_key_check` 一個字都不碰 —— 那些加密材料被覆蓋就永久解不開。 |
| 認不出來的檔案**完全不碰** | 監看的是「所有信件附件」混合區，工作文件也在裡面。只有檔名對得上銀行規則、而且解析出金額的 PDF 才會被處理；其餘檔案不讀內容、不搬移、不改名。 |

## 一次性設定

### 1. 建立機器人專用帳號（Firebase Console）

Console → Authentication → Users → **Add user**

- Email：`billbot@mywallet.local`（不必是真的信箱，只是帳號名）
- Password：**自己設一組長密碼**，不要用你平常的密碼

建好之後把那一列的 **User UID** 記下來（下一步要用），同時也把**你自己那個 Google 帳號**的 User UID 記下來。

### 2. 放行規則（Console → Firestore Database → Rules）

在 `match /databases/{database}/documents { … }` 裡**加上**這一段（不要刪掉原有的規則，
Firestore 的規則是「有任一條放行就通過」，加這段不會影響你現有的權限）：

```
    // 帳單機器人（scripts/billbot）：只能讀寫「我這一份」卡片管家文件。
    // 其他任何路徑、其他任何使用者的資料都碰不到。
    match /users/{userId}/creditcard/{docId} {
      allow read, write: if request.auth != null && (
        request.auth.uid == userId
        || (request.auth.uid == '機器人帳號的UID' && userId == '你自己的UID')
      );
    }
```

把兩個 UID 換成第 1 步記下來的值，按 **Publish**。

### 3. 設定檔

```bash
mkdir -p ~/.config/mywallet && cp scripts/billbot/billbot.example.json ~/.config/mywallet/billbot.json
```

打開 `~/.config/mywallet/billbot.json` 把 `owner_uid` 填成你自己的 UID。
其餘欄位已經填好（監看資料夾、專案 ID、網頁用的公開 apiKey）。
**這個檔案裡不放任何密碼。**

### 4. 密碼進 Keychain

機器人帳號密碼（`-w` 後面不帶值，會互動式詢問，不會留在 shell 歷史）：

```bash
security add-generic-password -s mywallet-billbot-firebase -a billbot@mywallet.local -U -T /usr/bin/security -w
```

各家銀行的 PDF 密碼 —— 舊的 Windows 機器人 `config.json` 裡已經有十家，一次匯入：

```bash
python3 scripts/billbot/import_pdf_passwords.py --write
```

匯入後確認、並把舊設定檔的明文密碼清掉：

```bash
python3 scripts/billbot/import_pdf_passwords.py --verify
```

要手動加或日後銀行改密碼（`<代號>` 用 `sinopac` `fubon` `taishin` `chb` `cathay`
`esun` `ubot` `ctbc` `dbs` `shinkong` `hncb` `firstbank`）：

```bash
security add-generic-password -s mywallet-bill-pdf -a <代號> -U -T /usr/bin/security -w
```

### 5. 建立專用 app（決定硬碟存取權給誰）

```bash
scripts/billbot/build-app.sh
```

排程要讀桌面與 OneDrive 底下的檔案，macOS 要求「完全取硬碟存取權」。而這個權限**綁的是
實際執行的那支執行檔** —— 直接授權 `python3`，等於讓這台機器上任何 Python 腳本都能讀你
所有檔案。`build-app.sh` 產生一個只會做這件事的 `帳單機器人.app`（專案路徑編譯進去、
ad-hoc 簽章、固定 bundle id），把權限收斂到它一個。

建好之後到 **系統設定 → 隱私權與安全性 → 完全取硬碟存取權**，按 `+`、用 ⌘⇧G 貼上
`scripts/billbot/帳單機器人.app` 的完整路徑，加入並開啟。安裝排程時腳本也會再印一次
「需要授權」的路徑。

`.app` 是建置產物，不進版控。**搬動專案資料夾之後要重跑 `build-app.sh`**，
並把新的 `.app` 重新加進權限清單（路徑是編譯進去的）。

### 6. 檢查是否就緒

```bash
python3 scripts/billbot/bill_bot.py --setup-check
```

會逐項確認設定檔、Keychain、機器人登入、雲端讀取、以及哪幾家銀行已有 PDF 密碼。

### 7. 先試跑，再裝排程

```bash
python3 scripts/billbot/bill_bot.py --dry-run --verbose
```

`--dry-run` 全程照跑但**不寫雲端**，會印出「會新增哪幾筆」。看起來對了再安裝排程：

```bash
scripts/billbot/install-schedule.sh 0 12 0
```

## 日常操作

| 要做什麼 | 指令 |
|---|---|
| 立刻跑一次 | `scripts/billbot/install-schedule.sh --run-now` |
| 看排程狀態、下次執行時間 | `scripts/billbot/install-schedule.sh --status` |
| 改成每週三 22:30 | `scripts/billbot/install-schedule.sh 3 22 30` |
| 改成每天 09:00 | `scripts/billbot/install-schedule.sh --daily 9 0` |
| 移除排程 | `scripts/billbot/install-schedule.sh --uninstall` |
| 看記錄 | `tail -50 ~/Library/Logs/mywallet-billbot.log` |
| 不寫雲端，只看會做什麼 | `python3 scripts/billbot/bill_bot.py --dry-run --verbose` |

星期幾：`0`=日、`1`=一 …… `6`=六。

每次執行結束會跳 macOS 通知（新增了幾筆、共多少錢；失敗時也會通知）。

## 想改設定的時候看這裡

| 想改什麼 | 怎麼改 | 何時生效 |
|---|---|---|
| **執行時間** | 重跑安裝腳本：`install-schedule.sh 3 22 30`（週三 22:30）或 `--daily 9 0`（每天 09:00） | 立刻 |
| **監看的資料夾** | 編輯 `~/.config/mywallet/billbot.json` 的 `watch_dir` | 下次執行 |
| **處理完要不要刪檔** | 同上，改 `processed_action`（`keep`／`move`／`trash`） | 下次執行 |
| **某家銀行的 PDF 密碼變了** | `security add-generic-password -s mywallet-bill-pdf -a <代號> -U -T /usr/bin/security -w` | 下次執行 |
| **機器人帳號密碼變了** | 同上，`-s mywallet-billbot-firebase -a <那個 email>` | 下次執行 |
| **某家銀行金額或日期抓錯** | 改 `js/utils/bill-parse.js` 的 `processBankRules`。**網頁與排程共用這一份** | 排程立刻；網頁要 commit + push |
| **新增一家銀行** | ①`bill-parse.js` 加一條解析規則 ②`bill_bot.py` 的 `BANK_CODE_RULES` 加檔名對應 ③把該行的 PDF 密碼存進 Keychain | 同上 |
| **暫時停用排程** | `install-schedule.sh --uninstall`（程式與設定都留著，重裝即可） | 立刻 |
| **搬動整個專案資料夾** | 重跑 `build-app.sh`，並把新的 `.app` 重新加進「完全取硬碟存取權」 | 立刻 |
| **換到別台電腦跑** | 見下面「換到別台電腦，或從這台清掉」 | — |

改完設定檔之後跑這個確認沒打壞（JSON 多一個逗號就會整支停掉）：

```bash
python3 scripts/billbot/bill_bot.py --setup-check
```

改動解析規則之後，用 `--dry-run` 看抓到的金額對不對，再讓它真的寫入：

```bash
python3 scripts/billbot/bill_bot.py --dry-run --verbose
```

## 處理完的 PDF 要怎麼辦

設定檔的 `processed_action`（三選一）：

| 值 | 行為 |
|---|---|
| `keep` | 留在原處（範本預設，最保守） |
| `move` | 搬到 `watch_dir` 底下的「已處理帳單」子夾 |
| `trash` | 搬進 `~/.Trash`。**這個資料夾有 OneDrive 同步，所以等於在雲端也刪除**（OneDrive 的資源回收筒還會再留一份一段時間） |

目前這台機器設為 **`trash`**。

只有「認得出是哪家銀行、而且確定已入帳（或雲端本來就有）」的 PDF 會被動到；
認不出來的檔案、解析失敗的檔案，以及資料夾裡其他非帳單的檔案一律不碰。
`--dry-run` 不會動任何檔案，只會印出「會被丟掉幾個」。

**時序很重要**：清理一定在「寫入雲端成功 ＋ 帳本記錄寫完」之後才執行。
寫入失敗時檔案留在原處，下次再試。

不用 AppleScript 叫 Finder 刪檔 —— 背景執行的程式要控制 Finder 需要「自動化」權限，
而背景程式無法跳出詢問框，只會無聲失敗。直接搬進 `~/.Trash` 不需要額外權限。

## 換到別台電腦，或從這台清掉

**雲端那一半跟機器無關，換機器完全不用重做**：機器人帳號、Firestore 規則、
已經寫進去的帳單、程式碼（在 GitHub，`git clone` 就有）、OneDrive 的帳單資料夾。

> 清理舊機器時**不要刪掉機器人帳號或 Firestore 規則**。那兩個是共用的，
> 刪了新機器也連不上 —— 這是唯一容易搞錯的地方。

綁在特定機器上的只有六處：

| 東西 | 位置 | 清除 |
|---|---|---|
| 排程 | `~/Library/LaunchAgents/com.mywallet.billbot.plist` | `install-schedule.sh --uninstall` |
| 專用 app | `scripts/billbot/帳單機器人.app` | 直接刪（建置產物，`build-app.sh` 重建） |
| 硬碟存取權 | 系統設定 → 隱私權與安全性 → 完全取硬碟存取權 | 移除「帳單機器人」那一列 |
| 設定檔 | `~/.config/mywallet/billbot.json` | 刪（內有 uid 與路徑，沒有密碼） |
| 密碼 | Keychain，服務名稱 `mywallet-billbot-firebase` 與 `mywallet-bill-pdf` | 鑰匙圈存取搜 `mywallet` 刪 |
| 帳本與記錄 | `~/.local/state/mywallet/billbot-ledger.json`、`~/Library/Logs/mywallet-billbot*.log` | 刪 |

### 順序

1. **先把新機器裝好、試跑成功**（見下一小節），再回來清舊的。
   反過來做的話，中間卡住就兩邊都沒有。
2. 新機器 `--dry-run` 看起來對，再真的寫入一次，確認網頁上看得到。
3. 舊機器 `install-schedule.sh --uninstall`，然後按上表清掉其餘五處。

**不要讓兩台同時跑排程。** 帳本（ledger）是每台機器各自一份，但雲端那層有
「同名稱＋同截止日」的重複判斷，所以不會產生重複帳單；只是兩台都設 `trash` 的時候，
誰先跑誰把 PDF 丟進垃圾桶，另一台空跑。新機器驗證完就把舊的排程卸掉。

### 新機器要做的事

就是「一次性設定」的第 3 步起 —— 前兩步是雲端設定，已經做過了：
clone → 設定檔 → 密碼進 Keychain → `build-app.sh` ＋ 給權限 → `--setup-check` →
`--dry-run` → 裝排程。

兩個跟第一次不同的地方：

- **PDF 密碼要手動一家一家加。** 第 4 步的 `import_pdf_passwords.py` 讀的是舊 Windows
  機器人的設定檔，那份不在版控裡，新機器 clone 之後沒有。先在舊機器跑
  `--setup-check` 把「已有密碼的銀行代號」列出來，再到新機器用
  `security add-generic-password -s mywallet-bill-pdf -a <代號> -U -T /usr/bin/security -w`
  逐一加入。
- **先確認 OneDrive 已經把帳單資料夾同步到本機**，而且不是「僅線上」的佔位檔。

`processed_action` 設 `trash` 讓搬移單純不少：資料夾裡不會留舊帳單，新機器那本空帳本
就不會把舊檔案重新認一遍。若設的是 `keep`，換機器前先把資料夾清空 —— 否則新機器第一次
跑會把留著的 PDF 全部當成新的（雲端的重複判斷會接住，不會真的重複新增，但記錄會很吵）。

## 重複與遺失的防線

- **同一個檔案不會被處理兩次**：`~/.local/state/mywallet/billbot-ledger.json` 記著已處理檔案的 SHA-256。
- **同一期帳單不會重複新增**：雲端已有「同名稱＋同截止日」就跳過。
  金額與雲端不一致時會寫進記錄檔並提醒你自己看一下，**不會默默覆蓋**。
- **機器人加的帳單帶 `source: "billbot"`**，在網頁上分得出來是誰加的。

## 已知限制與風險

1. **網頁的雲端同步是「整包覆寫」的** —— 已加上合併防線。
   卡片管家在你改任何東西時，會把**本機整份 `bills` 陣列**上傳覆蓋雲端
   （`mycreditcard.html` 的 `triggerSync('upload')`）。原本的後果是：有個
   **開著好幾天沒重新整理**的分頁，在機器人寫入之後才在那個分頁上改東西，
   機器人加的那筆就會被覆蓋掉。
   v5.13.0 起上傳前會先讀雲端，把「本機沒有、而且是上次同步之後才新增」的帳單補回來
   （`BillParse.rescuableBills`：用帳單 id 當建立時間戳，比對 `card_last_cloud_sync` 水位）。
   **刻意不救回水位之前的帳單** —— 否則你刪掉的帳單會一直復活。
   `scripts/test-bill-sync.mjs` 守著這個行為，CI 會跑。

2. **13 家銀行的規則，目前只有聯邦銀行用真實帳單實測過這條排程路徑。**
   規則本身與網頁共用、網頁那邊都驗過，但排程端的取字是 pdfplumber、網頁端是 pdf.js。
   兩邊都用「Y 座標 3pt 一桶」重建行結構，理論上一致，但**第一次收到某家銀行的帳單時，
   建議先 `--dry-run` 看一下金額對不對**，再讓它自動寫入。

3. **完全取硬碟存取權綁的是「實際執行的執行檔」。**
   排程讀的是 `~/Library/CloudStorage/OneDrive-個人/…`，沒這個權限會失敗，
   記錄裡的徵兆是 `Operation not permitted`。
   要授權的是 `scripts/billbot/帳單機器人.app`（見「一次性設定」第 5 步）。
   **不要加 `/usr/bin/python3`** —— 它只是個轉接點（不是 symlink，會再去執行
   CommandLineTools 底下那支），TCC 不認，加了完全沒有作用；
   而且失敗訊息與「根本沒授權」一字不差，看不出是加錯了對象。

4. **OneDrive 必須已經把檔案下載到本機**（不是「僅線上」的佔位檔）。
   讀取時通常會自動觸發下載，但離線時會失敗。

5. **帳單的通訊地址等個資不經過這支腳本** —— 它只寫 `bills`（名稱、金額、日期、狀態）。

## 檔案

| 檔案 | 用途 |
|---|---|
| `bill_bot.py` | 主程式 |
| `parse_bridge.js` | 用 jsc 呼叫網頁那份解析規則的橋接 |
| `install-schedule.sh` | 安裝／修改／移除 launchd 排程 |
| `build-app.sh` | 產生 `帳單機器人.app`，讓硬碟存取權只授權給它一個 |
| `import_pdf_passwords.py` | 把舊 Windows 機器人的明文密碼搬進 Keychain |
| `billbot.example.json` | 設定檔範本（實際設定在 `~/.config/mywallet/billbot.json`） |
| `../../js/utils/bill-parse.js` | **13 家銀行的解析規則，與網頁共用的唯一一份** |
