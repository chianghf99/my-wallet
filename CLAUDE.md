# My Wallet

專案規範的本體在 `AGENTS.md`，下面一行把它整份帶進來。
**要改規範請改 `AGENTS.md`，不要在這裡另寫一份** —— 兩份一定會飄。

@AGENTS.md

---

## Claude Code 專屬

- **不要只把事實寫進 memory。** memory 是每台機器、每個工具各自一份，
  Antigravity／Gemini 讀不到，clone 到別台機器也不會跟著走。
  任何必須活過「換機器」或「換工具」的事實，要寫進 `AGENTS.md`、程式碼註解
  或 `.claude/progress.md`。memory 只放「這台機器此刻的狀態」。
- **memory 裡的斷言要先驗證再採用。** 它記錄的是寫下當時為真的事，不是現在。
  特別是環境類的（有沒有 node、檔案在哪、哪個 port），一律先查再用。
- **同一個資料夾可能有另一個 agent 在動。** Antigravity 也讀得到這個專案
  （它讀 `AGENTS.md`）。同時開兩邊會互相覆蓋而且雙方都不知道 ——
  開始大範圍改動之前先問使用者另一邊是不是關著的。
