#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""帳單機器人的推播回歸測試。

守的是什麼：
這支腳本跑在無人看管的排程裡，**唯一會讓你知道它做了什麼的管道就是推播**。
所以「推播送不出去」這件事本身絕對不能安靜 —— 2026-11-16 就踩過一次：
Telegram 因為 chat id 填錯回了 403，而 --telegram-test 照印「已送出測試訊息」
並以 0 離開。那個開關存在的唯一理由就是把這種錯誤變成吵的，結果它自己吞掉了。

所以這裡釘的是 tg() 的**回傳值**，不是它有沒有丟例外（它永遠不該丟例外：
資料都已經寫進雲端了，通知失敗不該讓整支程式變成失敗）。

不碰網路、不碰 Keychain、不需要 pdfplumber（那是延遲匯入的），所以 CI 跑得動。

執行：
    python3 scripts/billbot/test_bill_bot.py
"""

import io
import importlib.util
import os
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bill_bot', os.path.join(HERE, 'bill_bot.py'))
bb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bb)

failures = 0


def expect(name, got, want):
    global failures
    if got != want:
        failures += 1
        print(f'❌ {name}\n     實得 {got!r}\n     期望 {want!r}')
    else:
        print(f'✅ {name}')


# 把所有對外的出口都換掉：不印記錄、不跳通知、不連網路
notified = []
bb.log = lambda *a, **k: None
bb.vlog = lambda *a, **k: None
bb.notify = lambda title, msg: notified.append(msg)
bb.DRY_RUN = False


def with_post(fn):
    """換掉 _post_json，回傳 tg() 的結果"""
    bb._post_json = fn
    notified.clear()
    return bb.tg('測試訊息')


def http_error(code, body):
    return urllib.error.HTTPError('https://api.telegram.org/botX/sendMessage', code,
                                  'err', {}, io.BytesIO(body))


# --- tg() 的回傳值 --------------------------------------------------------

bb.tg_creds = lambda: ('token', '12345')
expect('送出成功要回 True', with_post(lambda url, payload, headers=None: {'ok': True}), True)
expect('送出成功不該跳「推播失敗」的通知', notified, [])

# 這一項就是 2026-11-16 踩到的那個洞
def raise_403(url, payload, headers=None):
    raise http_error(403, b'{"description":"Forbidden: the bot can\'t send messages to the bot"}')
expect('Telegram 回 403 要回 False（不可以報成功）', with_post(raise_403), False)
expect('送不出去時要跳 macOS 通知', len(notified), 1)

def raise_400(url, payload, headers=None):
    raise http_error(400, b'{"description":"Bad Request: chat not found"}')
expect('chat id 不存在（400）也要回 False', with_post(raise_400), False)

def raise_urlerror(url, payload, headers=None):
    raise urllib.error.URLError('連不上')
expect('連不上網路要回 False', with_post(raise_urlerror), False)

def raise_oserror(url, payload, headers=None):
    raise OSError('socket 壞了')
expect('OSError 也要回 False、不可以往外丟', with_post(raise_oserror), False)

# 回應不是 JSON 時不可以在解析錯誤訊息的時候自己爆掉
def raise_html(url, payload, headers=None):
    raise http_error(502, b'<html>Bad Gateway</html>')
expect('回應不是 JSON 時也要安全地回 False', with_post(raise_html), False)

# 沒設定 Keychain 不是錯誤，但也不是成功
bb.tg_creds = lambda: (None, None)
expect('Keychain 沒設定時回 False', with_post(lambda *a, **k: {'ok': True}), False)
expect('Keychain 沒設定時不該跳「推播失敗」的通知（那是另一回事）', notified, [])

# --dry-run 不送出，所以也不算成功
bb.tg_creds = lambda: ('token', '12345')
bb.DRY_RUN = True
expect('--dry-run 回 False（因為真的沒送）', with_post(lambda *a, **k: {'ok': True}), False)
bb.DRY_RUN = False


# --- 訊息組裝 -------------------------------------------------------------

added = [
    ({'file': 'a.pdf'}, {'name': '甲銀行', 'amount': 12345, 'date': '2026-12-01'}),
    ({'file': 'b.pdf'}, {'name': '乙銀行', 'amount': 6789, 'date': ''}),
    ({'file': 'c.pdf'}, {'name': 'A & B <銀行>', 'amount': 50, 'date': '2026-12-05'}),
]
msg = bb.added_message(added, 100, 103)
expect('筆數要對', '3 筆' in msg, True)
expect('合計要對', '$19,184' in msg, True)
expect('雲端筆數變化要對', '100 → 103' in msg, True)
expect('沒抓到截止日的要講清楚，不可以留空', '沒抓到截止日' in msg, True)
# Telegram 用 parse_mode: HTML，沒跳脫的 & < > 會讓整則訊息被拒收（或顯示錯亂）
expect('銀行名稱裡的 & 要跳脫', '&amp;' in msg, True)
expect('銀行名稱裡的角括號要跳脫', '&lt;銀行&gt;' in msg, True)
expect('esc 三個字元都要處理', bb.esc('a<b>&c'), 'a&lt;b&gt;&amp;c')
# 自動扣款帳戶末五碼是個資，不在 bill 的白名單欄位裡，絕不可能混進訊息
expect('訊息只用白名單欄位，不會帶出 autopayFrom', 'autopayFrom' in msg, False)


# --- pickUid 的本機對應：這支只認一組 uid，不猜 ---------------------------
# （雲端那邊的 pickUid 有自己的測試，這裡確認本機設定檔缺 owner_uid 時會明確失敗）
expect('設定檔沒有 owner_uid 時 doc_url 不可以組出 undefined 路徑',
       'None' in bb.doc_url({'project_id': 'p', 'owner_uid': None}), True)

# --- processed_action（交班書第 7 節）---------------------------------------
expect('move 原樣', bb.cleanup_action({'processed_action': 'move'}), 'move')
expect('keep 原樣', bb.cleanup_action({'processed_action': 'keep'}), 'keep')
expect('未知值走舊相容：有 move_processed 就 move',
       bb.cleanup_action({'processed_action': 'xyz', 'move_processed': True}), 'move')
expect('未知值走舊相容：沒有就 keep', bb.cleanup_action({'processed_action': 'xyz'}), 'keep')
if sys.platform == 'win32':
    # 有 send2trash 才允許 trash（進資源回收筒）；沒有就退回 keep，不可以偷偷刪
    expected = 'trash' if bb._send2trash_available() else 'keep'
    expect('Windows 上 trash：有 send2trash 才是 trash，否則 keep',
           bb.cleanup_action({'processed_action': 'trash'}), expected)
else:
    expect('非 Windows 上 trash 維持原樣', bb.cleanup_action({'processed_action': 'trash'}), 'trash')
expect('LOG_HINT 不含使用者家目錄路徑', bb.Path.home().as_posix() in bb.LOG_HINT, False)

# --- 解析橋接：中文不可以變亂碼（交班書 4.1、4.2）---------------------------
# 用假文字（不是真帳單）走完整路徑：寫暫存檔 → 跑 Node 橋接 → 以 utf-8 解碼。
# 2026-11 的踩坑：Windows 繁中預設 cp950，若漏掉 encoding='utf-8'，officialName 會變亂碼，
# 雲端的重複判斷就失效。這一組就是守那條防線。沒有 node 時略過（不假裝通過）。
import shutil as _shutil

_node = _shutil.which('node')
if _node is None:
    print('⏭  找不到 node，略過解析橋接測試')
else:
    # 只換掉「用哪個執行器」，其餘（暫存檔、解碼、JSON 解析）全部走正式路徑
    bb.rules_command = lambda p: [_node, str(bb.PARSE_BRIDGE_NODE), str(p)]

    def _is_cjk(s):
        return bool(s) and all('一' <= c <= '鿿' for c in s)

    fubon = bb.run_bank_rules('富邦信用卡.pdf', '富邦信用卡帳單\n本期應繳總額 1,234\n繳款截止日 115/12/01\n')
    expect('富邦：橋接有回傳結果', fubon is not None, True)
    if fubon:
        expect('富邦：銀行名稱', fubon['bankName'], '富邦信用卡')
        expect('富邦：金額', fubon['amount'], 1234)
        expect('富邦：截止日有解析出來', fubon['dueDate'] != '未知日期', True)
        expect('富邦：officialName 不含亂碼字元 U+FFFD', '�' in fubon['officialName'], False)
        expect('富邦：officialName 是中文', _is_cjk(fubon['officialName']), True)

    ubot = bb.run_bank_rules('聯邦信用卡.pdf', '之信用卡消費帳單：2,500\n')
    expect('聯邦：橋接有回傳結果', ubot is not None, True)
    if ubot:
        expect('聯邦：銀行名稱', ubot['bankName'], '聯邦信用卡')
        expect('聯邦：金額', ubot['amount'], 2500)
        expect('聯邦：officialName 是中文', _is_cjk(ubot['officialName']), True)

print('\n✅ 全部通過' if failures == 0 else f'\n❌ 有 {failures} 項失敗')
sys.exit(1 if failures else 0)
