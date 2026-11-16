# Git hooks

這個目錄的 hook **不會自動生效**。`.git/hooks/` 和 `core.hooksPath` 設定都不會跟著
clone 過來，所以換機器或重新 clone 之後要跑一次：

```bash
git config core.hooksPath .githooks
```

**沒跑就等於沒有防護，而且不會有任何提示** —— commit 照樣成功。這是這個設定最危險的
地方，所以寫在這裡（進版控的檔案）而不只寫在本機筆記裡。

確認目前狀態：

```bash
git config core.hooksPath
```

要印出 `.githooks` 才算生效。

## commit-msg

`my-wallet` 是 public repo，**commit 訊息要跟 Actions 日誌同等對待**。這支 hook 擋掉
會把個資寫進公開歷史的訊息：

- 貨幣金額（`NT$`、`US$`、`TWD`、`USD`、`$`、`＄` 後面接數字）
- 以「元」計價的金額（`0 元` 不算）
- 28 碼的 Firebase uid
- PDF 檔名（帳單檔名本身就帶資訊）
- `blocklist.local.txt` 裡的本機字詞（銀行名等）

要證明測過，寫**筆數、狀態、比例、相對關係**就夠了：
「新增 1 筆，bills 134 → 135」「較小者恰為較大者的 10.2%」可以，具體金額不行。

誤判時（公開行情、假設計算）用 `git commit --no-verify` 跳過。
實測 411 筆歷史訊息會擋下 5 筆，其中 3 筆是誤判。

## blocklist.local.txt

**不進版控**，因為銀行名與持股代號本身就不該出現在 public repo —— 寫進會被推上去的
檔案等於 hook 自己洩漏它要保護的東西。

從範本建立自己的一份：

```bash
cp .githooks/blocklist.local.example.txt .githooks/blocklist.local.txt
```
