#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日帳單到期提醒發射器 —— 從 24 小時開機的筆電每天早上準時觸發 GitHub Actions。

== 為什麼改由 Windows 排程觸發，而不是依賴 GitHub Actions 的 schedule？ ==

GitHub Actions 的免費 schedule 佇列延遲極不穩定（實測常見延遲 3～10 小時以上），
原本排在台北 07:47 的提醒經常拖到中午或下午才到。
改由本機 Windows 工作排程器每天 08:30 透過 REST API 發送 workflow_dispatch：
  1. 通常數秒內即啟動，早上 08:30 準時當作秘書早安簡報的一部分。
  2. 沿用既有的 Fine-grained GitHub PAT（mywallet-github-dispatch / pat，僅有
     Actions: Read and write 權限），Firebase 金鑰繼續留在 GitHub Secrets 不落地。
  3. 回歸測試閘門（test-bill-reminder.mjs）繼續留在 GitHub Actions CI 執行。

== 用法 ==

    python trigger_bill_reminder.py                 # 正常發射一次（排程每天 08:30 跑這個）
    python trigger_bill_reminder.py --dry-run       # 只檢查憑證與組裝請求，不真的打 GitHub API
    python trigger_bill_reminder.py --setup-check   # 檢查 GitHub PAT 與 Telegram 憑證是否就緒
    python trigger_bill_reminder.py --install-task  # 在 Windows 工作排程器建立／更新每日 08:30 排程
"""

import html
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trigger_snapshot as ts  # noqa: E402

DEFAULT_REPO = ts.DEFAULT_REPO
DEFAULT_WORKFLOW = 'bill-reminder.yml'
DEFAULT_REF = ts.DEFAULT_REF
DEFAULT_TIME = '08:30'
TASK_NAME = 'MyWallet-DailyBillReminderTrigger'

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

if sys.platform == 'win32':
    LOG_PATH = Path(os.environ.get('LOCALAPPDATA') or (Path.home() / 'AppData' / 'Local')) \
        / 'mywallet' / 'mywallet-bill-reminder-trigger.log'
    LOG_HINT = r'%LOCALAPPDATA%\mywallet\mywallet-bill-reminder-trigger.log'
else:
    LOG_PATH = Path.home() / 'Library' / 'Logs' / 'mywallet-bill-reminder-trigger.log'
    LOG_HINT = '~/Library/Logs/mywallet-bill-reminder-trigger.log'


def log(msg, level='INFO'):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} [{level}] {msg}"
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open('a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def esc(v):
    return html.escape(str(v), quote=False)


def send_telegram_alert(reason, dry_run=False):
    """發射失敗時立刻推播告警給秘書小艾（iris_bot_token），不混入帳單通知聊天室。"""
    token, chat_id, _ = ts.get_telegram_creds()
    if not token or not chat_id:
        log(f"未設定 Telegram 憑證（{ts.KEYCHAIN_TG_SERVICE}），無法推播失敗通知", 'WARN')
        return False

    text = "\n".join([
        "⚠️ <b>帳單到期提醒的筆電發射器執行失敗</b>",
        "",
        f"原因：<code>{esc(reason)}</code>",
        "請檢查筆電上的發射器設定：",
        "• 若為 HTTP 401 / 403：GitHub PAT 可能已過期，請重產一顆並執行 <code>python scripts/trigger_snapshot.py --set-pat</code>",
        f"• 記錄檔：<code>{esc(LOG_HINT)}</code>",
    ])

    if dry_run:
        log(f"--dry-run：本來會推播一則失敗告警（{reason}）")
        return False

    body = json.dumps({
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': True,
    }).encode('utf-8')
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        log(f"Telegram 告警推播失敗：{type(e).__name__}", 'WARN')
        return False


def trigger_bill_reminder(pat, repo=DEFAULT_REPO, workflow=DEFAULT_WORKFLOW,
                          ref=DEFAULT_REF, opener=urllib.request.urlopen):
    return ts.trigger_workflow(
        pat,
        repo=repo,
        workflow=workflow,
        ref=ref,
        target_date=None,
        opener=opener,
    )


def build_powershell_task_script(python_exe, script_path, time_str=DEFAULT_TIME):
    py = str(python_exe).replace("'", "''")
    sc = str(script_path).replace("'", "''")
    wd = str(Path(script_path).resolve().parent.parent).replace("'", "''")
    return "\n".join([
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$ErrorActionPreference = 'Stop'",
        f"$action = New-ScheduledTaskAction -Execute '{py}' -Argument '\"{sc}\"' -WorkingDirectory '{wd}'",
        f"$trigger = New-ScheduledTaskTrigger -Daily -At '{time_str}'",
        "$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
        f"Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Description '每日 {time_str} 觸發 GitHub Actions 執行 MyWallet 帳單到期提醒' -Force | Out-Null",
        f"Write-Host 'OK: 已建立工作排程 {TASK_NAME}（每天 {time_str}，已啟用喚醒與錯過補跑）'",
    ])


def install_windows_task(time_str=DEFAULT_TIME):
    if sys.platform != 'win32':
        log("--install-task 僅適用於 Windows 工作排程器", 'ERROR')
        return 2
    ps_script = build_powershell_task_script(sys.executable, Path(__file__).resolve(), time_str)
    try:
        r = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_script],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    except Exception as e:
        log(f"呼叫 PowerShell 失敗：{e}", 'ERROR')
        return 2
    if r.returncode != 0:
        log(f"建立工作排程失敗：{r.stderr.strip() or r.stdout.strip()}", 'ERROR')
        return 2
    log(r.stdout.strip())
    return 0


def cmd_setup_check():
    pat = ts.keychain_get(ts.KEYCHAIN_GH_SERVICE, ts.KEYCHAIN_GH_ACCOUNT)
    tg_tok, tg_cid, tg_acc = ts.get_telegram_creds()

    print("=== 帳單到期提醒發射器 設定檢查 ===")
    print(f"1. GitHub PAT（{ts.KEYCHAIN_GH_SERVICE} / {ts.KEYCHAIN_GH_ACCOUNT}）："
          f"{'✅ 已設定（長度 ' + str(len(pat)) + '）' if pat else '❌ 未設定（請執行 trigger_snapshot.py --set-pat）'}")
    print(f"2. Telegram 告警憑證（{ts.KEYCHAIN_TG_SERVICE}）："
          f"{'✅ 已設定（使用 ' + str(tg_acc) + '）' if (tg_tok and tg_cid) else '⚠️ 未設定（發射失敗時無法由本機即時推播）'}")
    print(f"3. 目標 workflow：{DEFAULT_REPO} / {DEFAULT_WORKFLOW} ({DEFAULT_REF})")
    print(f"4. 記錄檔路徑：{LOG_PATH}")
    return 0 if pat else 2


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if '--setup-check' in args:
        return cmd_setup_check()
    if '--install-task' in args:
        time_str = DEFAULT_TIME
        if '--time' in args:
            idx = args.index('--time')
            if idx + 1 < len(args):
                time_str = args[idx + 1]
        return install_windows_task(time_str)

    dry_run = '--dry-run' in args
    pat = ts.keychain_get(ts.KEYCHAIN_GH_SERVICE, ts.KEYCHAIN_GH_ACCOUNT)
    if not pat:
        reason = f"系統密碼庫找不到 GitHub PAT（{ts.KEYCHAIN_GH_SERVICE}/{ts.KEYCHAIN_GH_ACCOUNT}）"
        log(reason, 'ERROR')
        send_telegram_alert(reason, dry_run=dry_run)
        return 2

    if dry_run:
        url = ts.dispatch_url(DEFAULT_REPO, DEFAULT_WORKFLOW)
        log(f"--dry-run：已讀到 PAT（長度 {len(pat)}），將對 {url} 發送 POST（不實際送出）")
        return 0

    ok, detail = trigger_bill_reminder(pat)
    if ok:
        log(f"已成功觸發 GitHub Actions 帳單到期提醒（{detail}）")
        return 0

    log(f"觸發帳單到期提醒失敗：{detail}", 'ERROR')
    send_telegram_alert(detail, dry_run=False)
    return 1


if __name__ == '__main__':
    sys.exit(main())
