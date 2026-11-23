#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日資產快照發射器 —— 從 24 小時開機的電腦準時發 workflow_dispatch 訊號給 GitHub Actions。

== 為什麼不在這台電腦直接跑 snapshot.mjs，而是只發訊號？ ==

1. 金鑰不落地：
   snapshot.mjs 需要 FIREBASE_SERVICE_ACCOUNT（擁有整個 Firebase 專案最高權限的金鑰）。
   把這支腳本做成純發射器，那把最高權限金鑰就繼續鎖在 GitHub Secrets，
   這台電腦只需要一組 Fine-grained GitHub PAT（只開 my-wallet 的 Actions: Read and write）。
   即使這組 PAT 外洩，對方也只能幫你按「執行快照」，讀不到任何資產資料、也改不了程式碼。

2. 測試閘門留在 CI：
   daily-snapshot.yml 寫入快照前會先跑 test-valuation / test-futures / test-snapshot，
   由 GitHub 統一把關，本機不需要維護 Node 的 firebase-admin 環境。

3. 解決 GitHub schedule 嚴重延遲（7～12 小時）：
   GitHub Actions 會針對 schedule 事件在高負載時大幅延遲甚至跨過台北午夜；
   但由外部透過 REST API 觸發 workflow_dispatch 不受 cron 佇列延遲影響，通常數秒內即啟動。

== 兩層失敗防護 ==

- 第一層（本機當場通報）：
  若發送訊號時遇到 HTTP 401/403（PAT 過期或權限不足）或網路斷線，這支腳本會直接用
  本機認證管理員裡既有的 Telegram 憑證（mywallet-telegram，與 billbot 共用）當場推播警告。
- 第二層（雲端看門狗）：
  若這台電腦整台關機、睡死或排程被刪，連這支腳本都沒跑，GitHub 的 schedule 保底仍會補上快照，
  而每天早上的 bill-reminder.mjs 會檢查 history 文件裡的 dispatchedAt 時戳 ——
  連續 3 天沒有收到外部觸發就會推 Telegram 警告，不會讓保底機制掩蓋筆電死掉的事實。

== 用法 ==

    python trigger_snapshot.py                 # 正常發射一次（工作排程器每天 14:35 跑這個）
    python trigger_snapshot.py --dry-run       # 只檢查憑證與組裝請求，不真的打 GitHub API
    python trigger_snapshot.py --setup-check   # 檢查 GitHub PAT 與 Telegram 憑證是否就緒
    python trigger_snapshot.py --set-pat       # 互動式把 GitHub PAT 存入系統密碼庫（不留命令列歷史）
    python trigger_snapshot.py --install-task  # 在 Windows 工作排程器建立／更新每日 14:35 排程
                                               # （自動勾選 WakeToRun 與 StartWhenAvailable）
"""

import getpass
import html
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

KEYCHAIN_GH_SERVICE = 'mywallet-github-dispatch'
KEYCHAIN_GH_ACCOUNT = 'pat'
KEYCHAIN_TG_SERVICE = 'mywallet-telegram'

DEFAULT_REPO = 'chianghf99/my-wallet'
DEFAULT_WORKFLOW = 'daily-snapshot.yml'
DEFAULT_REF = 'main'
TASK_NAME = 'MyWallet-DailySnapshotTrigger'

if sys.platform == 'win32':
    LOG_PATH = Path(os.environ.get('LOCALAPPDATA') or (Path.home() / 'AppData' / 'Local')) \
        / 'mywallet' / 'mywallet-snapshot-trigger.log'
    LOG_HINT = r'%LOCALAPPDATA%\mywallet\mywallet-snapshot-trigger.log'
else:
    LOG_PATH = Path.home() / 'Library' / 'Logs' / 'mywallet-snapshot-trigger.log'
    LOG_HINT = '~/Library/Logs/mywallet-snapshot-trigger.log'


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


# --- 系統密碼庫（Windows 認證管理員 / macOS Keychain） ------------------

def keychain_get(service, account):
    if sys.platform == 'win32':
        try:
            import keyring
        except ImportError:
            log("缺少 keyring 套件，請執行 pip install keyring", 'ERROR')
            return None
        try:
            return keyring.get_password(service, account)
        except Exception as e:
            log(f"讀取認證管理員失敗（{service}）：{type(e).__name__}", 'WARN')
            return None
    else:
        try:
            r = subprocess.run(
                ['security', 'find-generic-password', '-s', service, '-a', account, '-w'],
                capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError) as e:
            log(f"讀取 Keychain 失敗（{service}/{account}）：{e}", 'WARN')
            return None
        if r.returncode != 0:
            return None
        return r.stdout.rstrip('\n')


def keychain_set(service, account, secret):
    if sys.platform == 'win32':
        import keyring
        keyring.set_password(service, account, secret)
    else:
        subprocess.run(
            ['security', 'add-generic-password', '-s', service, '-a', account,
             '-U', '-T', '/usr/bin/security', '-w', secret],
            check=True)


# --- Telegram 失敗通報 --------------------------------------------------

def send_telegram_alert(reason, dry_run=False):
    """發射失敗時立刻用本機 Telegram 憑證通知使用者（例如 PAT 到期 401）。
    回傳布林值代表是否真的送出。
    """
    token = keychain_get(KEYCHAIN_TG_SERVICE, 'bot_token')
    chat_id = keychain_get(KEYCHAIN_TG_SERVICE, 'chat_id')
    if not token or not chat_id:
        log(f"未設定 Telegram 憑證（{KEYCHAIN_TG_SERVICE}），無法推播失敗通知", 'WARN')
        return False

    text = "\n".join([
        "⚠️ <b>每日快照的筆電發射器執行失敗</b>",
        "",
        f"原因：<code>{esc(reason)}</code>",
        "今晚 GitHub 自己的排程仍會保底補上快照，但請檢查筆電上的發射器設定：",
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


# --- GitHub workflow_dispatch -------------------------------------------

def dispatch_url(repo=DEFAULT_REPO, workflow=DEFAULT_WORKFLOW):
    return f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches"


def build_dispatch_payload(ref=DEFAULT_REF, target_date=None):
    payload = {'ref': ref}
    if target_date:
        payload['inputs'] = {'target_date': str(target_date).strip()}
    return payload


def trigger_workflow(pat, repo=DEFAULT_REPO, workflow=DEFAULT_WORKFLOW,
                     ref=DEFAULT_REF, target_date=None, opener=urllib.request.urlopen):
    """呼叫 GitHub REST API 觸發 workflow_dispatch。
    成功時 GitHub 回 HTTP 204 No Content，回傳 (True, 'HTTP 204')；
    失敗時回傳 (False, 錯誤描述字串) —— 絕不把 PAT 放進錯誤描述裡。
    """
    if not pat or not str(pat).strip():
        return False, "缺少 GitHub PAT（請先執行 --set-pat）"

    url = dispatch_url(repo, workflow)
    data = json.dumps(build_dispatch_payload(ref, target_date)).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Accept': 'application/vnd.github+json',
            'Authorization': f'Bearer {pat.strip()}',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'mywallet-snapshot-trigger/1.0',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with opener(req, timeout=20) as resp:
            code = getattr(resp, 'status', None) or resp.getcode()
            if code in (200, 201, 204):
                return True, f"HTTP {code}"
            return False, f"非預期的回應狀態碼 HTTP {code}"
    except urllib.error.HTTPError as e:
        hint = ""
        if e.code == 401:
            hint = "（PAT 無效或已過期）"
        elif e.code == 403:
            hint = "（PAT 缺少 Actions: Read and write 權限，或已過期）"
        elif e.code == 404:
            hint = "（找不到 workflow 或 PAT 無此 repo 權限）"
        return False, f"GitHub API 回應 HTTP {e.code}{hint}"
    except urllib.error.URLError as e:
        return False, f"網路連線失敗：{e.reason}"
    except Exception as e:
        return False, f"未預期錯誤：{type(e).__name__}"


# --- Windows 工作排程器安裝 ---------------------------------------------

def build_powershell_task_script(python_exe, script_path, time_str='14:35'):
    """組出建立 Windows 工作排程器的 PowerShell 指令。
    關鍵設定（漏掉任一個在筆電上都會無聲失效）：
      - WakeToRun：筆電若在睡眠中，喚醒電腦執行
      - StartWhenAvailable：錯過排程時間（例如重開機或關機）後一開機就盡快補跑
      - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries：避免剛好停電轉電池時不跑
    """
    py = str(python_exe).replace("'", "''")
    sc = str(script_path).replace("'", "''")
    wd = str(Path(script_path).resolve().parent.parent).replace("'", "''")
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        f"$action = New-ScheduledTaskAction -Execute '{py}' -Argument '\"{sc}\"' -WorkingDirectory '{wd}'",
        f"$trigger = New-ScheduledTaskTrigger -Daily -At '{time_str}'",
        "$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
        f"Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Description '每日 14:35 觸發 GitHub Actions 執行 MyWallet 資產快照' -Force | Out-Null",
        f"Write-Host '✅ 已建立工作排程：{TASK_NAME}（每天 {time_str}，已啟用喚醒與錯過補跑）'",
    ])


def install_windows_task(time_str='14:35'):
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


# --- CLI 入口 -----------------------------------------------------------

def cmd_setup_check():
    pat = keychain_get(KEYCHAIN_GH_SERVICE, KEYCHAIN_GH_ACCOUNT)
    tg_tok = keychain_get(KEYCHAIN_TG_SERVICE, 'bot_token')
    tg_cid = keychain_get(KEYCHAIN_TG_SERVICE, 'chat_id')

    print("=== 每日快照發射器 設定檢查 ===")
    print(f"1. GitHub PAT（{KEYCHAIN_GH_SERVICE} / {KEYCHAIN_GH_ACCOUNT}）："
          f"{'✅ 已設定（長度 ' + str(len(pat)) + '）' if pat else '❌ 未設定（請執行 --set-pat）'}")
    print(f"2. Telegram 告警憑證（{KEYCHAIN_TG_SERVICE}）："
          f"{'✅ 已設定（與 billbot 共用）' if (tg_tok and tg_cid) else '⚠️ 未設定（發射失敗時無法由本機即時推播，僅靠雲端 3 天看門狗）'}")
    print(f"3. 記錄檔路徑：{LOG_PATH}")
    return 0 if pat else 2


def cmd_set_pat():
    print(f"請貼上 GitHub Fine-grained PAT（只開 {DEFAULT_REPO} 的 Actions: Read and write）：")
    pat = getpass.getpass("PAT（輸入時不會顯示）：").strip()
    if not pat:
        print("❌ 未輸入內容，已取消")
        return 2
    keychain_set(KEYCHAIN_GH_SERVICE, KEYCHAIN_GH_ACCOUNT, pat)
    read_back = keychain_get(KEYCHAIN_GH_SERVICE, KEYCHAIN_GH_ACCOUNT)
    if read_back == pat:
        print(f"✅ 已存入系統密碼庫（{KEYCHAIN_GH_SERVICE} / {KEYCHAIN_GH_ACCOUNT}）並驗證讀取成功")
        return 0
    print("❌ 寫入後讀回不一致，請檢查系統密碼庫與 keyring 套件")
    return 2


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if '--setup-check' in args:
        return cmd_setup_check()
    if '--set-pat' in args:
        return cmd_set_pat()
    if '--install-task' in args:
        return install_windows_task()

    dry_run = '--dry-run' in args
    pat = keychain_get(KEYCHAIN_GH_SERVICE, KEYCHAIN_GH_ACCOUNT)
    if not pat:
        reason = f"系統密碼庫找不到 GitHub PAT（{KEYCHAIN_GH_SERVICE}/{KEYCHAIN_GH_ACCOUNT}）"
        log(reason, 'ERROR')
        send_telegram_alert(reason, dry_run=dry_run)
        return 2

    if dry_run:
        log(f"--dry-run：已讀到 PAT（長度 {len(pat)}），將對 {dispatch_url()} 發送 POST（不實際送出）")
        return 0

    ok, detail = trigger_workflow(pat)
    if ok:
        log(f"已成功觸發 GitHub Actions 每日快照（{detail}）")
        return 0

    log(f"觸發每日快照失敗：{detail}", 'ERROR')
    send_telegram_alert(detail, dry_run=False)
    return 1


if __name__ == '__main__':
    sys.exit(main())
