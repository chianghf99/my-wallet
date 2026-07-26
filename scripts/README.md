# 排程任務

## 每日資產快照

`snapshot.mjs` 由 [`.github/workflows/daily-snapshot.yml`](../.github/workflows/daily-snapshot.yml)
在每個交易日 **14:30（台北）** 觸發，流程：

1. 抓匯率（失敗就整支中止，不寫入 —— 用預設匯率算出來的淨值會永久污染走勢圖）
2. 抓台股（Yahoo v8）、美股（Finnhub）、期貨（鉅亨近全 / 台積電現貨）報價，並寫回 Firestore
3. 依 `js/main.js` 的估值邏輯算出淨資產、槓桿、曝險等指標
4. 寫入 `users/{uid}/history/{YYYY-MM-DD}`，並標記 `source: 'scheduled'`

### 為什麼是 14:30

台股 13:30 收盤、期貨一般交易時段 13:45 收盤，14:30 抓到的是當日確定的收盤價。
美股當時尚未開盤（美東 02:30），因此每日快照中的美股部位會是**前一交易日**收盤價 —— 這是台股收盤快照的必然結果。

### 需要的 GitHub Secrets

| 名稱 | 內容 | 必填 |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase 服務帳戶金鑰 JSON（整份貼上） | ✅ |
| `FINNHUB_API_KEY` | 美股報價 API 金鑰 | 美股持倉才需要 |
| `APP_UID` | Firebase 使用者 uid | 選填，留空會自動掃 `users` 底下所有帳號 |

### 注意事項

- **估值邏輯與 `js/main.js` 是兩份實作**。前端改公式時，`buildSnapshot()` 要一起改，否則排程與手動快照會算出不同數字。
- GitHub Actions 的 cron 不保證準時，可能延後數分鐘到半小時；對收盤快照沒有影響。
- 國定假日休市時會照跑，抓到的是前一交易日收盤價，等於複製前一天的快照，走勢圖呈現持平，不影響正確性。
- 可在 Actions 頁面用 **Run workflow** 手動觸發測試。
