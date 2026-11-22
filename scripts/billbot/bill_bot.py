#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""帳單機器人 —— 定時把資料夾裡的信用卡帳單 PDF 寫進卡片管家的雲端資料。

使用者要做的事只有「從電子信箱把帳單下載到指定資料夾」。其餘由 launchd 定時觸發這支
腳本完成：解開 PDF 密碼 → 解析銀行／金額／繳款截止日 → 寫進 Firestore。

== 為什麼是這個架構 ==

1. 解析規則不另寫一份。
   13 家銀行的規則原本只存在 mycreditcard.html 裡，現在抽到 js/utils/bill-parse.js，
   網頁與這支排程共用同一份，用系統內建的 jsc 執行（這台機器沒有 node）。
   另寫一份 Python 規則的代價是「改了網頁沒改排程」時排程會默默解析出錯的金額 ——
   而帳單金額錯掉不會有任何徵兆，直到你照著錯的數字去繳款。

2. 「上傳到網頁」＝寫進 Firestore，不是 commit 進 repo。
   卡片管家的資料放在 users/{uid}/creditcard/data 這一份文件裡，網頁只是讀它。
   my-wallet 是 public repo，把帳單金額寫進去等於公開。

3. 認證用「機器人專用帳號」，不用服務帳戶金鑰。
   服務帳戶金鑰是整個 Firebase 專案的管理權，而這個專案裡有其他使用者的帳號
   （見 CLAUDE.md）。排程只需要寫一份文件，所以改用一個 email/密碼帳號，
   再靠 Firestore 規則把它限制在「只能動你那一份 creditcard 文件」。
   硬碟上因此沒有任何金鑰檔，密碼放 macOS Keychain。

4. 密碼一律從 Keychain 讀，不寫在設定檔裡。
   PDF 密碼（每家銀行不同）與機器人帳號密碼都存在 Keychain，這支腳本只在執行當下讀取，
   既不會進版控，也不會出現在設定檔或 shell 歷史裡。

5. 只動 bills 欄位。
   寫入用 Firestore REST 的 updateMask，只碰 bills（與 billbot_last_run、
   billbot_heartbeat 這兩個自己的欄位）。
   cards、app_key_salt、app_key_check 這些加密材料一個字都不會被動到 ——
   那些欄位一旦被覆蓋，既有加密資料就永久解不開（見 .claude/progress.md）。

6. 不認得的檔案一概不碰。
   監看的資料夾是「所有信件附件」的混合區（工作文件也在裡面）。
   只有「檔名對得上某家銀行規則、而且解析出金額」的 PDF 才會被處理，
   其餘檔案不讀內容、不搬移、不改名。

== 用法 ==

    python3 bill_bot.py              # 正常執行（launchd 定時跑的就是這個）
    python3 bill_bot.py --dry-run    # 全程照跑但不寫雲端，先看會新增什麼
    python3 bill_bot.py --verbose    # 連「跳過了哪些檔案、為什麼」都印出來
    python3 bill_bot.py --setup-check # 只檢查設定、Keychain、雲端連線是否就緒
    python3 bill_bot.py --telegram-test # 只推一則測試訊息，確認 Telegram 真的通

設定檔：~/.config/mywallet/billbot.json（刻意放在 repo 外，避免誤 commit）
記錄檔：~/Library/Logs/mywallet-billbot.log
處理過的檔案帳本：~/.local/state/mywallet/billbot-ledger.json
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import hashlib
import html
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PARSE_MODULE = REPO / 'js' / 'utils' / 'bill-parse.js'
PARSE_BRIDGE = Path(__file__).resolve().parent / 'parse_bridge.js'          # macOS：jsc 用
PARSE_BRIDGE_NODE = Path(__file__).resolve().parent / 'parse_bridge_node.mjs'  # Windows：Node 用
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'

CONFIG_PATH = Path.home() / '.config' / 'mywallet' / 'billbot.json'
LEDGER_PATH = Path.home() / '.local' / 'state' / 'mywallet' / 'billbot-ledger.json'
if sys.platform == 'win32':
    # Windows 用 %LOCALAPPDATA%（不放在 ~ 底下，免得出現莫名的 Library 資料夾）
    LOG_PATH = Path(os.environ.get('LOCALAPPDATA') or (Path.home() / 'AppData' / 'Local')) \
        / 'mywallet' / 'mywallet-billbot.log'
    LOG_HINT = r'%LOCALAPPDATA%\mywallet\mywallet-billbot.log'
else:
    LOG_PATH = Path.home() / 'Library' / 'Logs' / 'mywallet-billbot.log'
    LOG_HINT = '~/Library/Logs/mywallet-billbot.log'
# 推播訊息用的路徑提示：只給相對的寫法，不印出使用者名稱或完整家目錄

KEYCHAIN_PDF_SERVICE = 'mywallet-bill-pdf'
KEYCHAIN_BOT_SERVICE = 'mywallet-billbot-firebase'
# Telegram 的 token 與 chat id（帳號名固定為 bot_token / chat_id）。
# 與密碼一樣放 Keychain，不進設定檔、不進版控。
KEYCHAIN_TG_SERVICE = 'mywallet-telegram'

# 檔名 → 銀行代號（決定去 Keychain 拿哪一組 PDF 密碼）。
# 這裡的關鍵字刻意與 js/utils/bill-parse.js 的 processBankRules 判斷一致，
# 順序也一樣 —— 富邦的 /^\d+年\d+月/ 這類寬鬆規則必須排在專屬關鍵字後面。
BANK_CODE_RULES = [
    ('dbs',      [r'cbgcc', r'dbs', r'星展']),
    ('fubon',    [r'就學貸款']),
    ('sinopac',  [r'永豐', r'sinopac']),
    ('taishin',  [r'台新', r'tsb']),
    ('cathay',   [r'國泰', r'消費明細']),
    ('chb',      [r'彰化', r'chb']),
    ('esun',     [r'玉山', r'esun']),
    ('ubot',     [r'聯邦', r'ubot']),
    ('ctbc',     [r'ctbc', r'中信']),
    ('shinkong', [r'新光', r'信用卡帳單\d+年\d+月']),
    ('hncb',     [r'credita', r'華南', r'hncb']),
    ('firstbank',[r'第一銀行', r'第一銀', r'一銀', r'firstbank', r'電子對帳單\d+年\d+月']),
    ('fubon',    [r'富邦', r'^\d+年\d+月']),
]

VERBOSE = False
DRY_RUN = False
# 已經為某個失敗推過 Telegram 了，收尾的那層就不要再推一則通用的
TG_FAILED_SENT = False


# --- 記錄 ---------------------------------------------------------------

def log(msg, level='INFO'):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} [{level}] {msg}"
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open('a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass          # 寫不進記錄檔不該讓整支程式停擺


def vlog(msg):
    if VERBOSE:
        log(msg, 'DEBUG')


def notify(title, message):
    """跳一個 macOS 通知。排程是無人看管的，沒有通知就不會知道它做了什麼。"""
    try:
        subprocess.run(
            ['osascript', '-e',
             f'display notification {json.dumps(message)} with title {json.dumps(title)}'],
            check=False, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


# --- 設定與 Keychain ----------------------------------------------------

def load_config():
    if not CONFIG_PATH.exists():
        log(f"找不到設定檔 {CONFIG_PATH}，請先照 scripts/billbot/README.md 建立", 'ERROR')
        sys.exit(2)
    cfg = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    missing = [k for k in ('watch_dir', 'owner_uid', 'bot_email', 'project_id', 'api_key')
               if not cfg.get(k)]
    if missing:
        log(f"設定檔缺少欄位：{', '.join(missing)}", 'ERROR')
        sys.exit(2)
    return cfg


def keychain_get(service, account):
    """從系統密碼庫讀一組密碼。讀不到回 None（不是致命錯誤：有些銀行的 PDF 沒加密）。

    macOS 用 Keychain（security 指令），Windows 用認證管理員（keyring 套件）。
    所有呼叫處都經過這裡，不要在外面自己判斷平台。
    """
    if sys.platform == 'win32':
        return _windows_vault_get(service, account)
    return _macos_keychain_get(service, account)


def _windows_vault_get(service, account):
    # keyring 延後載入：CI（ubuntu）跑 test_bill_bot.py 時不需要它
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


def _macos_keychain_get(service, account):
    try:
        r = subprocess.run(
            ['security', 'find-generic-password', '-s', service, '-a', account, '-w'],
            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as e:
        log(f"讀取 Keychain 失敗（{service}/{account}）：{e}", 'WARN')
        return None
    if r.returncode != 0:
        return None
    # security 會在結尾多一個換行；密碼本身不會被印出來
    return r.stdout.rstrip('\n')


def bank_code_for(filename):
    name = filename.lower()
    for code, patterns in BANK_CODE_RULES:
        for pat in patterns:
            if re.search(pat, name):
                return code
    return None


# --- Telegram 通知 ------------------------------------------------------
#
# 為什麼本機這一支要自己發 Telegram，而不是把狀態寫到雲端讓排程代勞：
# 這支腳本最危險的失敗全都發生在「碰到 Firestore 之前」—— 設定檔壞了、Keychain 讀不到、
# 完全取硬碟存取權被收回、OneDrive 檔案還是佔位檔。那些情況下它根本沒辦法把狀態寫上雲端
# 讓別人代報，只有它自己能說。macOS 通知只有坐在這台機器前面才看得到，而排程是週日中午跑的。
#
# 雲端那邊另有一層看門狗（scripts/bill-reminder.mjs 讀 billbot_heartbeat），
# 負責「這支腳本連跑都沒跑」的情況 —— 死掉的程式不會自己報死訊。

def tg_creds():
    token = keychain_get(KEYCHAIN_TG_SERVICE, 'bot_token')
    chat_id = keychain_get(KEYCHAIN_TG_SERVICE, 'chat_id')
    return (token, chat_id) if token and chat_id else (None, None)


def esc(v):
    """Telegram 的 HTML 模式只需要處理這三個字元。"""
    return html.escape(str(v), quote=False)


def tg(message, is_failure=False):
    """推一則 Telegram，**回傳有沒有真的送出去**。

    永遠不丟例外、永遠不改離開碼 —— 資料都已經寫進雲端了，通知失敗不該讓整支程式
    變成失敗。但「送不出去」必須讓呼叫端知道：--telegram-test 的全部意義就是把
    chat id 填錯這種錯誤變成吵的，它要是跟著一起吞掉，那個開關就等於不存在
    （2026-11-16 實際踩到：Telegram 回 403，腳本照印「已送出測試訊息」並以 0 離開）。
    """
    global TG_FAILED_SENT
    if is_failure:
        TG_FAILED_SENT = True
    token, chat_id = tg_creds()
    if not token or not chat_id:
        log(f'Keychain 裡沒有 Telegram 的 bot_token／chat_id（服務 {KEYCHAIN_TG_SERVICE}），'
            '略過推播。設定方式見 README.md', 'WARN')
        return False
    if DRY_RUN:
        log(f"--dry-run：本來會推一則 {len(message.splitlines())} 行的 Telegram（內容不印）")
        return False
    try:
        _post_json(f'https://api.telegram.org/bot{token}/sendMessage',
                   {'chat_id': chat_id, 'text': message,
                    'parse_mode': 'HTML', 'disable_web_page_preview': True})
        vlog('Telegram 已送出')
        return True
    except urllib.error.HTTPError as e:
        # 回應可能把我們送出去的訊息原文帶回來（裡面有金額），只取 description
        desc = ''
        try:
            desc = json.loads(e.read().decode('utf-8', 'replace')).get('description', '')
        except (ValueError, OSError):
            pass
        log(f"Telegram 推播失敗（HTTP {e.code}）{'：' + desc if desc else ''}", 'WARN')
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"Telegram 推播失敗：{type(e).__name__}", 'WARN')
    # 排程是無人看管的，而這條路徑代表「該通知你的事情通知不到」。
    # 記錄檔沒人會每週去翻，所以至少讓這台機器跳一個通知。
    notify('帳單機器人', 'Telegram 推播失敗，詳見記錄檔')
    return False


def added_message(added, before, after):
    lines = ['✅ <b>帳單機器人</b>',
             f"已同步 {len(added)} 筆新帳單到卡片管家：", '']
    for _item, b in added:
        lines.append(f"• {esc(b['name'])}　${b['amount']:,}　"
                     + (f"{esc(b['date'])} 到期" if b['date'] else '沒抓到截止日'))
    total = sum(b['amount'] for _i, b in added)
    lines += ['', f"合計 ${total:,}　雲端帳單 {before} → {after} 筆"]
    return '\n'.join(lines)


# --- PDF 取字 -----------------------------------------------------------

def extract_text(pdf_path, passwords, max_pages=3):
    """抽出 PDF 前幾頁的文字，並重建成與網頁端相同的行結構。

    ⚠️ 不能用 pdfplumber 的 extract_text() 直接交差。網頁端是用 pdf.js 的 Y 座標
    自行分行（3pt 一桶、同一行內按 X 排序、用一個空白串接），而華南、第一銀行、
    國泰的規則都依賴「標籤一行、數字在下一行」這個版面結構。這裡用 extract_words()
    以同樣的規則重建，兩邊的行結構才會一致。

    回傳 (text, 用掉的密碼或 None)；全部密碼都打不開時回傳 (None, None)。
    """
    import pdfplumber

    last_err = None
    for pw in passwords:
        try:
            with pdfplumber.open(str(pdf_path), password=pw) as pdf:
                lines_out = []
                for page in pdf.pages[:max_pages]:
                    buckets = {}
                    for w in page.extract_words(use_text_flow=False, keep_blank_chars=False):
                        # bottom ≈ 基線，與 pdf.js 的 transform[5] 對應；3pt 一桶
                        key = round(w['bottom'] / 3) * 3
                        buckets.setdefault(key, []).append((w['x0'], w['text']))
                    for key in sorted(buckets):            # top → bottom
                        row = sorted(buckets[key], key=lambda t: t[0])
                        lines_out.append(' '.join(t[1] for t in row))
                return '\n'.join(lines_out) + '\n', pw
        except Exception as e:
            # 不能靠錯誤訊息判斷「是不是密碼錯」：pdfminer 的 PDFPasswordIncorrect
            # 丟出來時 str(e) 是**空字串**，用關鍵字比對會誤判成「檔案有問題」而
            # 提早放棄，後面幾組密碼根本沒試到。所以一律換下一組，全部試完才算失敗。
            last_err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            continue
    if last_err:
        vlog(f"  所有密碼都打不開，最後一個錯誤：{last_err}")
    return None, None


# --- 跑網頁那一份解析規則（macOS 用 jsc，Windows 用 Node）-----------------

def rules_command(input_path):
    """組出執行解析規則的命令。兩條路徑輸出合約相同：最後一行是 JSON。

    macOS 那條 jsc 路徑不動（它是回退路徑，見交班書 4.3）。
    """
    if sys.platform == 'win32':
        node = shutil.which('node')
        if not node:
            raise OSError('找不到 node（Node.js 未安裝，或不在 PATH 裡）')
        return [node, str(PARSE_BRIDGE_NODE), str(input_path)]
    return [JSC, str(PARSE_MODULE), str(input_path), str(PARSE_BRIDGE)]


def run_bank_rules(filename, text):
    # 用 tempfile 找暫存目錄：Windows 沒有 TMPDIR，寫死 /tmp 會寫不進去，
    # 而那個失敗會被下面的 except 吃掉、每筆帳單都靜靜跳過（交班書 4.1）。
    tmp = Path(tempfile.gettempdir()) / f'billbot-input-{os.getpid()}.js'
    try:
        tmp.write_text(
            'globalThis.__INPUT = ' +
            json.dumps({'filename': filename, 'text': text}, ensure_ascii=True) + ';\n',
            encoding='utf-8')
        # 明確指定 utf-8：Windows 繁中預設是 cp950，會把中文輸出解成亂碼並寫進雲端，
        # 造成重複帳單判斷失效（交班書 4.2，這是整件事最危險的一處）。
        r = subprocess.run(rules_command(tmp),
                           capture_output=True, text=True, encoding='utf-8',
                           timeout=60)
        if r.returncode != 0:
            log(f"jsc 執行失敗：{r.stderr.strip()[:300]}", 'ERROR')
            return None
        last = [l for l in r.stdout.strip().split('\n') if l.strip()]
        if not last:
            log('jsc 沒有輸出', 'ERROR')
            return None
        out = json.loads(last[-1])
        if not out.get('ok'):
            log(f"解析規則拋出例外：{out.get('error')}", 'ERROR')
            return None
        return out
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        log(f"呼叫解析規則失敗：{e}", 'ERROR')
        return None
    finally:
        tmp.unlink(missing_ok=True)


# --- Firestore REST -----------------------------------------------------

def _post_json(url, payload, headers=None):
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'Content-Type': 'application/json',
                                          **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def sign_in(cfg, password):
    url = ('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='
           + urllib.parse.quote(cfg['api_key']))
    try:
        out = _post_json(url, {'email': cfg['bot_email'], 'password': password,
                               'returnSecureToken': True})
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        log(f"機器人帳號登入失敗（HTTP {e.code}）：{detail}", 'ERROR')
        return None
    except urllib.error.URLError as e:
        log(f"連不上 Firebase：{e}", 'ERROR')
        return None
    return out.get('idToken')


def doc_url(cfg):
    return (f"https://firestore.googleapis.com/v1/projects/{cfg['project_id']}"
            f"/databases/(default)/documents/users/{cfg['owner_uid']}/creditcard/data")


def to_fs(v):
    if v is None:
        return {'nullValue': None}
    if isinstance(v, bool):
        return {'booleanValue': v}
    if isinstance(v, int):
        return {'integerValue': str(v)}
    if isinstance(v, float):
        return {'doubleValue': v}
    if isinstance(v, str):
        return {'stringValue': v}
    if isinstance(v, list):
        return {'arrayValue': {'values': [to_fs(x) for x in v]}}
    if isinstance(v, dict):
        return {'mapValue': {'fields': {k: to_fs(x) for k, x in v.items()}}}
    raise TypeError(f'無法轉成 Firestore 值：{type(v)}')


def from_fs(v):
    kind, val = next(iter(v.items()))
    if kind == 'nullValue':
        return None
    if kind == 'integerValue':
        return int(val)
    if kind == 'doubleValue':
        return float(val)
    if kind == 'arrayValue':
        return [from_fs(x) for x in val.get('values', [])]
    if kind == 'mapValue':
        return {k: from_fs(x) for k, x in val.get('fields', {}).items()}
    return val          # stringValue / booleanValue / timestampValue 原樣帶回


def fetch_doc(cfg, token):
    req = urllib.request.Request(doc_url(cfg), headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        if e.code == 403:
            log('讀取雲端資料被拒（403）。Firestore 規則還沒放行機器人帳號，'
                '見 scripts/billbot/README.md 的規則片段', 'ERROR')
        elif e.code == 404:
            log('雲端還沒有 creditcard/data 這份文件。請先在卡片管家按一次「上傳到雲端」', 'ERROR')
        else:
            log(f"讀取雲端資料失敗（HTTP {e.code}）：{detail}", 'ERROR')
        return None


def patch_bills(cfg, token, bills):
    url = (doc_url(cfg)
           + '?updateMask.fieldPaths=bills&updateMask.fieldPaths=billbot_last_run')
    payload = {'fields': {'bills': to_fs(bills),
                          'billbot_last_run': to_fs(int(time.time() * 1000))}}
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PATCH',
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        log(f"寫入雲端失敗（HTTP {e.code}）：{detail}", 'ERROR')
        return False
    except urllib.error.URLError as e:
        log(f"寫入雲端失敗：{e}", 'ERROR')
        return False


def patch_heartbeat(cfg, token):
    """只寫 billbot_heartbeat 一個欄位，updateMask 刻意不含 bills。

    為什麼不跟 patch_bills 共用：心跳在「這次沒有新帳單」時也要寫，而那條路徑手上的
    bills 是舊的（甚至沒去讀）。把它一起 PATCH 回去等於拿舊資料覆蓋雲端 ——
    網頁可能在這之間改過。updateMask 只列心跳欄位，就不可能動到 bills。
    """
    url = doc_url(cfg) + '?updateMask.fieldPaths=billbot_heartbeat'
    payload = {'fields': {'billbot_heartbeat': to_fs(int(time.time() * 1000))}}
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PATCH',
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
        return True
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
        log(f"心跳寫入失敗：{type(e).__name__}", 'WARN')
        return False


def write_heartbeat(cfg, bot_pw, token=None):
    """跑完就蓋一個時戳上雲端。

    雲端的看門狗靠它分辨兩件長得一樣的事：「這週真的沒有新帳單」與「機器人根本沒跑」
    （Mac 關機、排程被卸掉、硬碟存取權被收回）。前者是常態，後者是帳單會遲繳。

    刻意只在「跑完」的路徑寫 —— 中途 sys.exit 的失敗不寫，這樣連續失敗也會讓看門狗叫。
    """
    if DRY_RUN:
        vlog('--dry-run：不寫心跳')
        return
    if not bot_pw:
        return
    if token is None:
        token = sign_in(cfg, bot_pw)
        if not token:
            # 「沒有新帳單」那條路徑本來連登入都不用，所以登入失敗以前不會有人知道。
            # 現在它會讓心跳停掉，看門狗幾天後才會叫，所以當場也說一聲。
            tg('⚠️ <b>帳單機器人</b>\n跑完了，但寫心跳時登入失敗。\n'
               '雲端看門狗可能會誤報「機器人沒跑」。')
            return
    if not patch_heartbeat(cfg, token):
        tg('⚠️ <b>帳單機器人</b>\n跑完了，但心跳寫不進雲端。\n'
           '雲端看門狗可能會誤報「機器人沒跑」。')


# --- 處理過的檔案帳本 ---------------------------------------------------

def load_ledger():
    if LEDGER_PATH.exists():
        try:
            return json.loads(LEDGER_PATH.read_text(encoding='utf-8'))
        except ValueError:
            log('帳本檔格式壞了，這次當成空的重新開始', 'WARN')
    return {}


def save_ledger(ledger):
    if DRY_RUN:
        return
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2),
                           encoding='utf-8')


def cleanup_action(cfg):
    """處理完的 PDF 要怎麼辦：keep（留著）／move（搬到子夾）／trash（丟垃圾桶）。"""
    act = str(cfg.get('processed_action', '') or '').lower()
    if act in ('keep', 'move', 'trash'):
        if act == 'trash' and sys.platform == 'win32':
            # Windows 上 ~/.Trash 只是一般資料夾，不是資源回收筒；而且 OneDrive 把
            # 「檔案離開同步資料夾」當成雲端刪除。寧可留著，也不要偷偷刪。
            log("processed_action=trash 在 Windows 不支援（~/.Trash 不是資源回收筒），"
                "本次改為 keep；請在設定檔把 processed_action 改成 move", 'WARN')
            return 'keep'
        return act
    return 'move' if cfg.get('move_processed') else 'keep'   # 舊設定檔的相容


def move_to_trash(path):
    """把檔案搬進 ~/.Trash。

    不用 AppleScript 叫 Finder 刪：背景執行的程式要控制 Finder 需要「自動化」權限，
    而背景程式無法跳出詢問框，只會無聲失敗。直接搬進 ~/.Trash 不需要任何額外權限，
    檔案一樣在垃圾桶裡、一樣救得回來（只是沒有「放回原處」的來源資訊）。

    這個資料夾是 OneDrive 同步的，所以檔案離開資料夾等於在雲端也刪除 ——
    OneDrive 自己的資源回收筒會再留一份一段時間。
    """
    trash = Path.home() / '.Trash'
    trash.mkdir(exist_ok=True)
    dest = trash / path.name
    if dest.exists():          # 同名時加時間戳，不要覆蓋垃圾桶裡既有的檔案
        dest = trash / f"{path.stem}_{datetime.now():%Y%m%d-%H%M%S}{path.suffix}"
    path.rename(dest)
    return dest


def cleanup_processed(items, cfg, watch_dir):
    """把已經確定入帳（或雲端已有）的 PDF 依設定搬走或丟掉。

    只在「資料已經安全落地」之後才呼叫 —— 寫雲端失敗時絕對不能動使用者的檔案。
    """
    act = cleanup_action(cfg)
    if act == 'keep' or not items:
        return
    if DRY_RUN:        # --dry-run 絕對不能動使用者的檔案
        log(f"--dry-run：{len(items)} 個檔案「會」被"
            f"{'搬走' if act == 'move' else '丟進垃圾桶'}，這次沒有動")
        return
    dest_dir = watch_dir / cfg.get('processed_dir', '已處理帳單')
    if act == 'move':
        dest_dir.mkdir(exist_ok=True)
    done = 0
    for it in items:
        p = it['path']
        if not p.exists():
            continue
        try:
            if act == 'move':
                target = dest_dir / p.name
                if target.exists():
                    target = dest_dir / f"{p.stem}_{datetime.now():%Y%m%d-%H%M%S}{p.suffix}"
                p.rename(target)
            else:
                move_to_trash(p)
            done += 1
        except OSError as e:
            # 搬不動不影響已經上傳的資料，記下來就好
            log(f"{'搬移' if act == 'move' else '丟垃圾桶'}失敗（檔案留在原處）：{it['file']}：{e}", 'WARN')
    if done:
        log(f"已{'搬到「' + dest_dir.name + '」' if act == 'move' else '丟進垃圾桶'}：{done} 個檔案")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


# --- 主流程 -------------------------------------------------------------

def collect_pdfs(watch_dir):
    return sorted(p for p in Path(watch_dir).iterdir()
                  if p.is_file() and p.suffix.lower() == '.pdf' and not p.name.startswith('.'))


def main():
    global VERBOSE, DRY_RUN
    args = set(sys.argv[1:])
    VERBOSE = '--verbose' in args or '-v' in args
    DRY_RUN = '--dry-run' in args
    setup_check = '--setup-check' in args

    # 刻意排在讀設定檔之前：確認推播能不能通，不該被無關的雲端設定卡住。
    # 存在的理由與雲端排程的 test_send 一樣 —— chat id 填錯時 Telegram 會回 200，
    # 訊息卻送到你看不到的地方，是唯一一種安靜的失敗。
    if '--telegram-test' in args:
        if not all(tg_creds()):
            log(f'Keychain 裡沒有 {KEYCHAIN_TG_SERVICE} 的 bot_token／chat_id，'
                '見 README.md', 'ERROR')
            sys.exit(2)
        if not tg('✅ <b>帳單機器人</b>\n測試訊息：Telegram 這條路是通的。\n'
                  '平常只有「同步了新帳單」「這次沒有新帳單」「失敗」才會收到。'):
            # 上一行的 WARN 已經寫了 Telegram 給的拒絕原因（例如 chat not found、
            # Forbidden）。這裡要以非 0 離開 —— 這支指令唯一的工作就是回答
            # 「推播到底通不通」，報成功等於沒有這個開關。
            log('測試訊息送不出去，設定還沒完成（原因見上一行）', 'ERROR')
            sys.exit(2)
        log('測試訊息已送出，Telegram 已接受。手機上看不到的話，'
            '代表 chat id 指向的是別的對話 —— 那種情況 Telegram 一樣會回成功')
        return

    cfg = load_config()
    watch_dir = Path(os.path.expanduser(cfg['watch_dir']))
    if not watch_dir.is_dir():
        log(f"監看的資料夾不存在：{watch_dir}", 'ERROR')
        # 這也是「完全取硬碟存取權被收回」的徵兆 —— 資料夾明明在，程式卻看不到
        tg(f'❌ <b>帳單機器人</b>\n看不到監看的資料夾，這次完全沒跑。\n'
           f'可能是 OneDrive 沒同步，或是「完全取硬碟存取權」被收回了。\n'
           f'{esc(watch_dir)}', is_failure=True)
        sys.exit(2)

    bot_pw = keychain_get(KEYCHAIN_BOT_SERVICE, cfg['bot_email'])
    if not bot_pw:
        msg = (f"Keychain 裡沒有機器人帳號的密碼（服務 {KEYCHAIN_BOT_SERVICE}／"
               f"帳號 {cfg['bot_email']}），見 README.md")
        # --dry-run 刻意容許在 Firebase 那邊還沒設定好的情況下就能先驗證解析，
        # 否則「想先確認金額抓得對不對」會被卡在跟解析無關的雲端設定上。
        if DRY_RUN:
            log(msg + ' —— --dry-run 繼續跑，但不會與雲端比對重複', 'WARN')
        else:
            log(msg, 'ERROR')
            tg('❌ <b>帳單機器人</b>\nKeychain 裡讀不到機器人帳號的密碼，'
               '這次完全沒跑。\n見 scripts/billbot/README.md', is_failure=True)
            sys.exit(2)

    if setup_check:
        log(f"設定檔 OK；監看資料夾：{watch_dir}")
        token = sign_in(cfg, bot_pw)
        if not token:
            sys.exit(1)
        log('機器人帳號登入成功')
        doc = fetch_doc(cfg, token)
        if doc is None:
            sys.exit(1)
        bills = from_fs(doc.get('fields', {}).get('bills', {'arrayValue': {}})) or []
        cards = from_fs(doc.get('fields', {}).get('cards', {'arrayValue': {}})) or []
        log(f"雲端讀取成功：現有帳單 {len(bills)} 筆、卡片 {len(cards)} 張")
        codes = sorted({c for c, _ in BANK_CODE_RULES})
        have = [c for c in codes if keychain_get(KEYCHAIN_PDF_SERVICE, c)]
        log(f"Keychain 裡已有 PDF 密碼的銀行（{len(have)}/{len(codes)}）：{', '.join(have) or '無'}")
        tg_ok = all(tg_creds())
        log(f"Telegram 推播：{'已設定' if tg_ok else '沒設定（Keychain 缺 bot_token／chat_id）'}"
            + ('' if tg_ok else ' —— 排程失敗時不會通知你，見 README.md'))
        log('✅ 設定檢查通過')
        return

    pdfs = collect_pdfs(watch_dir)
    ledger = load_ledger()
    vlog(f"資料夾裡有 {len(pdfs)} 個 PDF")

    # 先把所有 PDF 解析完，再一次寫雲端（少一次登入、也少一次覆寫風險）
    parsed, failed, skipped = [], [], 0
    stale = []          # 帳本說早就入帳了，但檔案還在資料夾裡（見下方）
    for pdf in pdfs:
        digest = sha256_of(pdf)
        if digest in ledger and ledger[digest].get('status') == 'added':
            skipped += 1
            vlog(f"跳過（已處理過）：{pdf.name}")
            # 已入帳卻還留著的檔案，照 processed_action 清掉。
            # 會有這種檔案的兩個原因：①在開啟自動清檔之前就處理過了
            # ②上次清理失敗（例如檔案被佔用）。不補這段的話它們會永遠留在資料夾裡，
            # 因為每次都在這裡就被 continue 掉、走不到後面的清理。
            stale.append({'path': pdf, 'file': pdf.name})
            continue

        code = bank_code_for(pdf.name)
        if not code:
            skipped += 1
            vlog(f"跳過（檔名不像任何一家銀行的帳單，完全不讀內容）：{pdf.name}")
            continue

        # 密碼：先用檔名猜到的那家，不行再試其他已存的（有些銀行的 PDF 沒加密，
        # 所以 None 也要試一次）
        pw_guess = keychain_get(KEYCHAIN_PDF_SERVICE, code)
        others = [keychain_get(KEYCHAIN_PDF_SERVICE, c) for c, _ in BANK_CODE_RULES
                  if c != code]
        candidates = [pw_guess] + [None] + [p for p in others if p]
        candidates = [p for i, p in enumerate(candidates) if p not in candidates[:i]]

        text, used = extract_text(pdf, candidates)
        if text is None:
            log(f"打不開：{pdf.name}（{code} 的密碼可能沒存進 Keychain 或已變更）", 'WARN')
            failed.append((pdf.name, '密碼或檔案問題'))
            ledger[digest] = {'file': pdf.name, 'status': 'locked',
                              'at': datetime.now().isoformat(timespec='seconds'),
                              'tries': ledger.get(digest, {}).get('tries', 0) + 1}
            continue
        if used is None:
            vlog(f"  {pdf.name} 沒有加密")

        out = run_bank_rules(pdf.name, text)
        if out is None or out['amount'] < 0:
            log(f"解析不出金額：{pdf.name}（規則：{out['bankName'] if out else '未知'}）", 'WARN')
            failed.append((pdf.name, '解析不出金額'))
            ledger[digest] = {'file': pdf.name, 'status': 'unparsed',
                              'at': datetime.now().isoformat(timespec='seconds'),
                              'tries': ledger.get(digest, {}).get('tries', 0) + 1}
            continue

        parsed.append({'digest': digest, 'file': pdf.name, 'path': pdf,
                       'name': out['officialName'], 'keyword': out['keyword'],
                       'amount': int(out['amount']),
                       'date': '' if out['dueDate'] == '未知日期' else out['dueDate']})
        log(f"解析成功：{pdf.name} → {out['officialName']} ${out['amount']} "
            f"截止 {out['dueDate']}")

    if not parsed:
        msg = f"沒有新帳單（掃過 {len(pdfs)} 個 PDF，跳過 {skipped} 個）"
        log(msg)
        if failed:
            notify('帳單機器人', f"{len(failed)} 個檔案處理失敗，請看記錄檔")
            tg('⚠️ <b>帳單機器人</b>\n'
               f"{len(failed)} 個檔案處理失敗，沒有新增任何帳單：\n"
               + '\n'.join(f"• {esc(n)}：{esc(why)}" for n, why in failed)
               + '\n\n多半是 PDF 密碼變了，或這家銀行的版面改了。'
                 f'詳見 {LOG_HINT}',
               is_failure=True)
        elif cfg.get('telegram_notify_empty', True):
            # 「這次沒事」也要說一聲。使用者指定要的，理由也站得住腳：
            # 收到這則就等於知道排程活著，不必自己去記「上次是什麼時候跑的」。
            tg('🗂 <b>帳單機器人</b>\n'
               f"這次沒有新帳單（掃過 {len(pdfs)} 個檔案）。\n"
               '收到這則就代表排程有跑、機器人是活著的。')
        save_ledger(ledger)
        cleanup_processed(stale, cfg, watch_dir)
        write_heartbeat(cfg, bot_pw)
        return

    token, doc = None, None
    if bot_pw:
        token = sign_in(cfg, bot_pw)
        if not token:
            notify('帳單機器人', '登入失敗，帳單沒有上傳')
            tg('❌ <b>帳單機器人</b>\n機器人帳號登入失敗，解析好的帳單沒有上傳。\n'
               '可能是帳號密碼改了，或 Firebase 連不上。', is_failure=True)
            sys.exit(1)
        doc = fetch_doc(cfg, token)
        if doc is None:
            notify('帳單機器人', '讀不到雲端資料，帳單沒有上傳')
            tg('❌ <b>帳單機器人</b>\n讀不到雲端的卡片管家資料，帳單沒有上傳。\n'
               '可能是 Firestore 規則被改動了。', is_failure=True)
            sys.exit(1)
    elif not DRY_RUN:
        sys.exit(2)          # 理論上到不了這裡，上面已經擋掉

    fields = (doc or {}).get('fields', {})
    bills = from_fs(fields.get('bills', {'arrayValue': {}})) or []
    cards = from_fs(fields.get('cards', {'arrayValue': {}})) or []
    before = len(bills)

    added, dupes = [], []
    for item in parsed:
        # 重複判定：同一個帳單名稱 ＋ 同一個截止日就視為同一筆。
        # 不比對金額 —— 你可能已經手動輸入過同一期帳單（金額也許小有出入），
        # 這時要讓人去看，而不是默默多一筆或默默覆蓋。
        hit = next((b for b in bills
                    if str(b.get('name', '')) == item['name']
                    and str(b.get('date', '')) == item['date']), None)
        if hit:
            dupes.append(item)
            log(f"已存在，不重複新增：{item['name']} {item['date']}"
                + ('' if int(hit.get('amount', 0)) == item['amount']
                   else f"（雲端 ${hit.get('amount')}、這份帳單 ${item['amount']}，金額不一樣，請自己看一下）"))
            ledger[item['digest']] = {'file': item['file'], 'status': 'added',
                                      'at': datetime.now().isoformat(timespec='seconds'),
                                      'note': 'duplicate'}
            continue

        # 關聯卡片：與網頁同一套做法（先比對卡片名稱，再用銀行關鍵字兜底）
        card_id = ''
        for c in cards:
            cname = str(c.get('name', ''))
            if cname and (item['name'] in cname or cname in item['name']):
                card_id = str(c.get('id', ''))
                break

        # id 必須是「13 位毫秒數」，與網頁的 Date.now().toString() 同格式。
        # 網頁在上傳前會用 id 當建立時間，分辨雲端那筆是「別處新增的」還是「本機刪掉的」
        # （見 mycreditcard.html 的 billCreatedAt）。多接幾位流水號會讓它看起來像
        # 西元 5 萬年、永遠被判定成「新的」，刪掉之後還會被復活 —— 所以用遞增毫秒避免碰撞。
        bill = {'id': str(int(time.time() * 1000) + len(added)),
                'name': item['name'],
                'amount': item['amount'],
                'date': item['date'],
                'cardId': card_id,
                'status': 'unpaid',
                # 讓你在網頁上看得出哪幾筆是機器人加的
                'source': 'billbot'}
        bills.append(bill)
        added.append((item, bill))

    if not added:
        log(f"沒有要新增的帳單（{len(dupes)} 筆已存在）")
        save_ledger(ledger)
        # 雲端已經有這幾筆了，檔案該清掉的照清 —— 不然重複下載的帳單會永遠留在資料夾裡
        cleanup_processed(dupes + stale, cfg, watch_dir)
        notify('帳單機器人', f"{len(dupes)} 筆帳單雲端已有，沒有新增")
        tg('🗂 <b>帳單機器人</b>\n'
           f"掃到 {len(dupes)} 筆帳單，雲端都已經有了，沒有新增。")
        write_heartbeat(cfg, bot_pw, token)
        return

    if DRY_RUN:
        log('--dry-run：以下帳單「會」被寫入，但這次沒有實際寫入：')
        for item, bill in added:
            log(f"  + {bill['name']} ${bill['amount']} 截止 {bill['date'] or '（無日期）'} "
                f"← {item['file']}")
        log(f"bills 會從 {before} 筆變成 {len(bills)} 筆")
        return

    if not patch_bills(cfg, token, bills):
        notify('帳單機器人', '寫入雲端失敗，帳單沒有上傳')
        tg('❌ <b>帳單機器人</b>\n寫入雲端失敗，帳單沒有上傳。\n'
           'PDF 都留在原處，下次排程會再試一次。', is_failure=True)
        sys.exit(1)

    for item, _bill in added:
        ledger[item['digest']] = {'file': item['file'], 'status': 'added',
                                  'at': datetime.now().isoformat(timespec='seconds')}
    save_ledger(ledger)

    # 處理完的 PDF 要搬走還是丟掉（processed_action）。
    # 一定要在 patch_bills 成功、ledger 也寫完之後才做 —— 資料還沒安全落地就動
    # 使用者的檔案，萬一寫入失敗就兩頭空。
    cleanup_processed([it for it, _b in added] + dupes + stale, cfg, watch_dir)

    total = sum(b['amount'] for _i, b in added)
    log(f"✅ 已寫入雲端：新增 {len(added)} 筆，bills {before} → {len(bills)} 筆")
    detail = '、'.join(f"{b['name']} ${b['amount']:,}" for _i, b in added)
    notify('帳單機器人', f"新增 {len(added)} 筆帳單（共 ${total:,}）：{detail}")
    tg(added_message(added, before, len(bills)))
    write_heartbeat(cfg, bot_pw, token)


if __name__ == '__main__':
    # 為什麼要在最外層再包一層：main() 裡有好幾條 sys.exit 的路徑，以前只寫記錄檔；
    # 更糟的是未預期的例外（pdfplumber 或 jsc 不在、OneDrive 檔案讀到一半斷線）
    # 連記錄都只有 launchd 的 stderr。排程是無人看管的，沒推播就等於沒發生。
    try:
        main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        if code != 0 and not TG_FAILED_SENT:
            tg(f'❌ <b>帳單機器人</b>\n排程中止（exit {code}），帳單沒有上傳。\n'
               f'詳見 {LOG_HINT}', is_failure=True)
        raise
    except BaseException as e:
        # 例外內容只寫進本機記錄檔，推播只帶型別 —— 訊息會經過 Telegram 的伺服器
        log(f"未預期的錯誤：{type(e).__name__}: {e}", 'ERROR')
        notify('帳單機器人', '未預期的錯誤，帳單沒有上傳')
        tg(f'❌ <b>帳單機器人</b>\n未預期的錯誤（{esc(type(e).__name__)}），'
           f'帳單沒有上傳。\n詳見 {LOG_HINT}',
           is_failure=True)
        sys.exit(1)
