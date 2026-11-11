#!/bin/bash
# 在本機開一個測試伺服器（在 Finder 裡雙擊這個檔案即可）
#
# ⚠️ port 一定要是 8899，不要改。
# Cloudflare Worker（報價代理）的來源白名單只放行這個 port，換成別的會讓
# mystock.html 的所有報價請求 CORS 失敗 —— 畫面看起來像程式壞了，但其實只是 port 不對。
# 這支腳本原本寫 8080，就是這個坑。

cd "$(dirname "$0")"

PORT=8899

echo ""
echo "===================================="
echo " 測試伺服器已啟動（port $PORT）"
echo ""
echo " 資產帳本：  http://localhost:$PORT/mystock.html"
echo " 卡片管家：  http://localhost:$PORT/mycreditcard.html"
echo " 入口頁：    http://localhost:$PORT/"
echo ""
echo " 測試完後，直接關掉這個視窗就可以停止。"
echo "===================================="
echo ""

# 改過 js/*.js 之後若瀏覽器載到舊版，是 ES module 被快取了 ——
# 關掉這個視窗、重新雙擊一次（換個新連線）並開新分頁，詳見 .claude/progress.md
python3 -m http.server "$PORT"
