#!/bin/bash
# 手動執行帳單機器人（在 Finder 裡雙擊這個檔案即可）
#
# 為什麼需要這個檔：
# macOS 的隱私權保護（TCC）不讓 launchd 背景執行的程式讀取桌面、文件、下載與
# iCloud／OneDrive 這些受保護的位置，而且背景程式無法跳出詢問框，只會直接
# 「Operation not permitted」。要讓每週日的排程真的跑起來，必須到
# 系統設定 → 隱私權與安全性 → 完全取硬碟存取權 把 python3 加進去。
#
# 如果不想給那個權限，就用這個檔：雙擊它會在「終端機」裡執行，
# 而終端機本來就有你授權過的存取權，所以一切正常 —— 代價是你要自己點一下。
#
# 兩者可以並存：給了權限之後，這個檔仍然是「不想等到週日、現在就想跑一次」時的捷徑。

cd "$(dirname "$0")/../.." || exit 1

echo "════════════════════════════════════════"
echo "  帳單機器人"
echo "════════════════════════════════════════"
echo

/usr/bin/python3 scripts/billbot/bill_bot.py "$@" 2>&1 | grep -viE "NotOpenSSLWarning|warnings\.warn|FutureWarning|^  warnings"

echo
echo "════════════════════════════════════════"
echo "完成。這個視窗可以直接關掉。"
echo "（想先看看會做什麼而不實際寫入：在終端機執行"
echo "  python3 scripts/billbot/bill_bot.py --dry-run）"
echo "════════════════════════════════════════"
