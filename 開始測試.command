#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "===================================="
echo " 測試伺服器已啟動！"
echo " 請到瀏覽器打開這個網址："
echo ""
echo " http://localhost:8080/mycreditcard.html"
echo ""
echo " 測試完後，直接關掉這個黑色視窗就可以停止。"
echo "===================================="
echo ""
python3 -m http.server 8080
