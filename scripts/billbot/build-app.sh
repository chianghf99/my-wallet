#!/bin/bash
# 建立「帳單機器人.app」—— 用來承接「完全取硬碟存取權」的專用外殼
#
# 為什麼需要這個 app：
# 排程要讀桌面與 OneDrive 的檔案，就必須有完全取硬碟存取權（見 .claude/progress.md
# 的 TCC 那一節）。但那個權限是給「執行檔」的，所以直接授權 python3 等於讓這台機器上
# **任何** Python 腳本都能讀你所有的檔案 —— 包括你哪天從網路上複製來跑的那一支。
#
# 改成授權這個 app，範圍就從「所有 Python 腳本」縮小成「這一個 app」。
# 這是 macOS 上處理這種需求的標準做法。
#
# 為什麼主程式是 C 編出來的執行檔，而不是 shell 腳本：
# bundle 的主程式若是 shell 腳本，實際執行起來的 process 是 /bin/bash，
# TCC 要嘛把權限歸給 bash（比授權 python3 更糟），要嘛整個不認。
# 必須是真正的 Mach-O 執行檔，TCC 才會以「這個 app 的身分」來判斷。
# 它啟動的 python3 是它的子程序，會沿用這個 app 的身分，所以腳本本身不必改。
#
# 執行：./build-app.sh
# 之後要把產出的 .app 加進「系統設定 → 隱私權與安全性 → 完全取硬碟存取權」。
#
# .app 是建置產物，不進版控（見 .gitignore）。換機器時重跑這支即可。

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
APP="$DIR/帳單機器人.app"
BUNDLE_ID="com.mywallet.billbot.app"

command -v clang >/dev/null || { echo "❌ 找不到 clang（需要 Xcode Command Line Tools）"; exit 1; }

echo "▸ 專案路徑：$REPO"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# --- 主程式 ---
# 刻意把路徑寫死在編譯期：這個 app 的唯一用途就是跑這個專案的這支腳本。
# 能接受任意參數的啟動器會變成「用這個 app 的權限跑任何東西」的後門，
# 那就完全失去縮小範圍的意義了。
TMP="$(mktemp -d)"
cat > "$TMP/main.c" <<CEOF
// 帳單機器人的啟動器。唯一的事：切到專案目錄，執行 bill_bot.py。
// 不接受任何參數 —— 見 build-app.sh 的說明。
#include <unistd.h>

int main(void) {
    if (chdir("$REPO") != 0) return 1;
    char *const args[] = { "/usr/bin/python3", "scripts/billbot/bill_bot.py", NULL };
    execv("/usr/bin/python3", args);
    return 1;   // execv 成功就不會回來
}
CEOF

clang -O2 -o "$APP/Contents/MacOS/billbot" "$TMP/main.c"
rm -rf "$TMP"

# --- Info.plist ---
# LSBackgroundOnly：不要在 Dock 跳出圖示、不要搶焦點（它是排程用的）
cat > "$APP/Contents/Info.plist" <<PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>帳單機器人</string>
    <key>CFBundleDisplayName</key>     <string>帳單機器人</string>
    <key>CFBundleIdentifier</key>      <string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key>      <string>billbot</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleVersion</key>         <string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSBackgroundOnly</key>        <true/>
    <key>LSMinimumSystemVersion</key>  <string>12.0</string>
</dict>
</plist>
PEOF

# --- 簽章 ---
# ad-hoc 簽章（-s -）就夠了：TCC 要的是一個穩定的身分，不需要開發者憑證。
# 重新編譯後簽章會變，macOS 可能要求重新授權一次 —— 所以不要沒事重跑這支。
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"

echo "✅ 建好了：$APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Signature" | sed 's/^/   /'
echo
echo "接下來："
echo "  1. 系統設定 → 隱私權與安全性 → 完全取硬碟存取權，按 ＋ 加入這個 .app"
echo "  2. 把清單裡的 python3 移除（兩個都移）"
echo "  3. 重新安裝排程讓它改用這個 app：./install-schedule.sh 0 12 0"
echo "  4. 測試：./install-schedule.sh --run-now"
