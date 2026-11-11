#!/bin/bash
# 安裝／修改／移除帳單機器人的排程（macOS launchd）
#
# 為什麼用 launchd 而不是 cron：這台是筆電，排定的時間點很可能正在睡覺。
# launchd 的 StartCalendarInterval 會在「錯過的時間點」醒來後補跑一次，cron 不會。
#
# 用法：
#   ./install-schedule.sh                 # 預設：每週日 12:00
#   ./install-schedule.sh 0 12 0          # 星期幾(0=日) 時 分
#   ./install-schedule.sh 3 22 30         # 改成每週三 22:30
#   ./install-schedule.sh --daily 9 0     # 改成每天 09:00
#   ./install-schedule.sh --run-now       # 立刻跑一次（不改排程）
#   ./install-schedule.sh --status        # 看排程狀態與下次執行時間
#   ./install-schedule.sh --uninstall     # 移除排程
#
# 改時間就是重跑這支：它會先卸載舊的再載入新的，不會變成兩個排程。

set -euo pipefail

LABEL="com.mywallet.billbot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT="$SCRIPT_DIR/bill_bot.py"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG="$HOME/Library/Logs/mywallet-billbot-launchd.log"
UID_NUM="$(id -u)"

case "${1:-}" in
  --run-now)
    echo "▶︎ 立刻執行一次…"
    # 用 launchd 跑而不是直接 python3，才會跟排程走完全相同的環境
    launchctl kickstart -p "gui/$UID_NUM/$LABEL"
    echo "   記錄：tail -f \"$HOME/Library/Logs/mywallet-billbot.log\""
    exit 0 ;;
  --status)
    if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
      launchctl print "gui/$UID_NUM/$LABEL" | grep -E "state|runs|last exit|next fire|program|arguments" -A2 | head -30
    else
      echo "排程目前沒有載入。執行 ./install-schedule.sh 安裝。"
    fi
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ 排程已移除（腳本與設定都還在，重新執行這支即可裝回來）"
    exit 0 ;;
esac

if [[ "${1:-}" == "--daily" ]]; then
  MODE="daily"; HOUR="${2:-9}"; MIN="${3:-0}"
else
  MODE="weekly"; WEEKDAY="${1:-0}"; HOUR="${2:-12}"; MIN="${3:-0}"
fi

[[ -f "$BOT" ]] || { echo "❌ 找不到 $BOT"; exit 1; }

# 排程要執行誰？優先用專用的 .app（見 build-app.sh）。
#
# 這件事的重點是「完全取硬碟存取權」要授權給誰。排程必須讀桌面與 OneDrive 的檔案，
# 而那個權限是綁執行檔的：
#   直接授權 python3 → 這台機器上**任何** Python 腳本都能讀你所有檔案（範圍太大）
#   授權專用 .app   → 只有這個 app 有，其他 python 程式一律沒有
# 所以 .app 存在時就用它。
#
# 退路（.app 還沒建）：用 python3 實際的那支執行檔，不是 /usr/bin/python3 ——
# 後者只是個轉接點（不是 symlink，而是會再去執行 CommandLineTools 底下那支），
# 而 TCC 認的是**實際執行的執行檔**。授權轉接點完全沒有作用，而且失敗訊息
# 與「根本沒授權」一字不差，看不出是加錯了對象。
APP_BIN="$SCRIPT_DIR/帳單機器人.app/Contents/MacOS/billbot"
if [[ -x "$APP_BIN" ]]; then
    EXEC_DESC="專用 app（$SCRIPT_DIR/帳單機器人.app）"
    PROGRAM_ARGS="        <string>$APP_BIN</string>"
    TCC_TARGET="$SCRIPT_DIR/帳單機器人.app"
else
    PY="$(/usr/bin/python3 -c 'import sys; print(sys.executable)' 2>/dev/null)"
    [[ -x "$PY" ]] || PY=/usr/bin/python3
    EXEC_DESC="python3（$PY）—— 建議改用專用 app，執行 ./build-app.sh"
    PROGRAM_ARGS="        <string>$PY</string>
        <string>$BOT</string>"
    TCC_TARGET="$PY"
fi

if [[ "$MODE" == "weekly" ]]; then
  INTERVAL="        <key>Weekday</key><integer>$WEEKDAY</integer>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MIN</integer>"
  DAYS=(日 一 二 三 四 五 六)
  WHEN="每週${DAYS[$WEEKDAY]} $(printf '%02d:%02d' "$HOUR" "$MIN")"
else
  INTERVAL="        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MIN</integer>"
  WHEN="每天 $(printf '%02d:%02d' "$HOUR" "$MIN")"
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <!-- 要執行的東西。見上方關於 TCC 的說明 —— 這個路徑就是要加進
         「完全取硬碟存取權」的那一個，不要加別的。 -->
    <key>ProgramArguments</key>
    <array>
$PROGRAM_ARGS
    </array>

    <!-- $WHEN -->
    <key>StartCalendarInterval</key>
    <dict>
$INTERVAL
    </dict>

    <!-- 工作目錄固定在 repo，bill_bot.py 要用相對路徑找 js/utils/bill-parse.js -->
    <key>WorkingDirectory</key>
    <string>$REPO</string>

    <!-- 這裡只收 launchd 層面的異常（例如 python 根本起不來）；
         正常的執行記錄由腳本自己寫到 mywallet-billbot.log -->
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>

    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo "✅ 排程已安裝：$WHEN"
echo "   設定檔：$PLIST"
echo "   執行：$EXEC_DESC"
echo "   需要授權：$TCC_TARGET"
echo "   ↑ 這一個（且只有這一個）必須在「系統設定 → 隱私權與安全性 →"
echo "     完全取硬碟存取權」清單裡並開啟，否則背景執行讀不到桌面與 OneDrive 的檔案"
echo "     （錯誤訊息是 Operation not permitted，而且看不出原因）"
echo "   立刻測跑：$0 --run-now"
echo "   看狀態：  $0 --status"
echo "   改時間：  $0 <星期幾0-6> <時> <分>　或　$0 --daily <時> <分>"
