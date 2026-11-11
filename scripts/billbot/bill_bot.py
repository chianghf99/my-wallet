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
   寫入用 Firestore REST 的 updateMask，只碰 bills（與 billbot_last_run）。
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

設定檔：~/.config/mywallet/billbot.json（刻意放在 repo 外，避免誤 commit）
記錄檔：~/Library/Logs/mywallet-billbot.log
處理過的檔案帳本：~/.local/state/mywallet/billbot-ledger.json
"""

import json
import os
import re
import subprocess
import sys
import time
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PARSE_MODULE = REPO / 'js' / 'utils' / 'bill-parse.js'
PARSE_BRIDGE = Path(__file__).resolve().parent / 'parse_bridge.js'
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'

CONFIG_PATH = Path.home() / '.config' / 'mywallet' / 'billbot.json'
LEDGER_PATH = Path.home() / '.local' / 'state' / 'mywallet' / 'billbot-ledger.json'
LOG_PATH = Path.home() / 'Library' / 'Logs' / 'mywallet-billbot.log'

KEYCHAIN_PDF_SERVICE = 'mywallet-bill-pdf'
KEYCHAIN_BOT_SERVICE = 'mywallet-billbot-firebase'

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
    """從 Keychain 讀一組密碼。讀不到回 None（不是致命錯誤：有些銀行的 PDF 沒加密）。"""
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


# --- 用 jsc 跑網頁那一份解析規則 ----------------------------------------

def run_bank_rules(filename, text):
    tmp = Path(os.environ.get('TMPDIR', '/tmp')) / f'billbot-input-{os.getpid()}.js'
    try:
        tmp.write_text(
            'globalThis.__INPUT = ' +
            json.dumps({'filename': filename, 'text': text}, ensure_ascii=True) + ';\n',
            encoding='utf-8')
        r = subprocess.run([JSC, str(PARSE_MODULE), str(tmp), str(PARSE_BRIDGE)],
                           capture_output=True, text=True, timeout=60)
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

    cfg = load_config()
    watch_dir = Path(os.path.expanduser(cfg['watch_dir']))
    if not watch_dir.is_dir():
        log(f"監看的資料夾不存在：{watch_dir}", 'ERROR')
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
        save_ledger(ledger)
        cleanup_processed(stale, cfg, watch_dir)
        return

    token, doc = None, None
    if bot_pw:
        token = sign_in(cfg, bot_pw)
        if not token:
            notify('帳單機器人', '登入失敗，帳單沒有上傳')
            sys.exit(1)
        doc = fetch_doc(cfg, token)
        if doc is None:
            notify('帳單機器人', '讀不到雲端資料，帳單沒有上傳')
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


if __name__ == '__main__':
    main()
