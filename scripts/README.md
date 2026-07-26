# 排程任務

## 每日資產快照

`snapshot.mjs` 由 [`.github/workflows/daily-snapshot.yml`](../.github/workflows/daily-snapshot.yml)
在每個交易日 **14:30（台北）** 觸發，流程：

1. 抓匯率（失敗就整支中止，不寫入 —— 用預設匯率算出來的淨值會永久污染走勢圖）
2. 抓台股與美股報價（Yahoo v8 為主，台股另有 MIS 與官方收盤快照兩層退路）、期貨（鉅亨近全 / 台積電現貨），並寫回 Firestore
3. 依 `js/main.js` 的估值邏輯算出淨資產、槓桿、曝險等指標
4. 寫入 `users/{uid}/history/{YYYY-MM-DD}`，並標記 `source: 'scheduled'`

### 為什麼是 14:30

台股 13:30 收盤、期貨一般交易時段 13:45 收盤，14:30 抓到的是當日確定的收盤價。
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

- **估值邏輯與 `js/main.js` 是兩份實作**。前端改公式時，`buildSnapshot()` 要一起改，否則排程與手動快照會算出不同數字。
- GitHub Actions 的 cron 不保證準時，可能延後數分鐘到半小時；對收盤快照沒有影響。
- 國定假日休市時會照跑，抓到的是前一交易日收盤價，等於複製前一天的快照，走勢圖呈現持平，不影響正確性。
- 可在 Actions 頁面用 **Run workflow** 手動觸發測試。
