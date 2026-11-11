#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把舊版 Windows 帳單機器人 config.json 裡的 PDF 密碼搬進 macOS Keychain。

為什麼要搬：那份 config.json 是**明文**存放十家銀行的 PDF 密碼。它有被 .gitignore
排除（沒有外流到 public repo），但明文躺在硬碟上沒有必要 —— 任何讀得到你家目錄的
程式都看得到。搬進 Keychain 之後，bill_bot.py 執行當下才去讀，設定檔裡不留密碼。

這支腳本全程不會把密碼印出來，只會印銀行代號與結果。

用法：
    python3 import_pdf_passwords.py            # 預覽會匯入哪些銀行（不寫入）
    python3 import_pdf_passwords.py --write    # 實際寫進 Keychain
    python3 import_pdf_passwords.py --verify   # 檢查 Keychain 裡現在有哪幾家

⚠️ 已知的小缺口：`security add-generic-password` 只能從命令列參數接收密碼，
執行的那一瞬間密碼會出現在 ps 的輸出裡（只有本機、只有那幾毫秒）。
介意的話就不要用這支，改為每家手動輸入（README.md 有指令，-w 後面不帶值會互動式詢問）。

匯入完成後，建議把 config.json 裡的 passwords 區塊刪掉或整個檔案收起來。
"""

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OLD_CONFIG = REPO / 'Build_Bot_in_windows' / 'config.json'
SERVICE = 'mywallet-bill-pdf'

# 舊設定檔的 key 與 bill_bot.py 的 BANK_CODE_RULES 代號一致，直接沿用
KNOWN = ['sinopac', 'fubon', 'taishin', 'chb', 'cathay', 'esun',
         'ubot', 'ctbc', 'dbs', 'shinkong', 'hncb', 'firstbank']


def has_item(account):
    r = subprocess.run(['security', 'find-generic-password', '-s', SERVICE,
                        '-a', account, '-w'], capture_output=True, text=True)
    return r.returncode == 0


def main():
    write = '--write' in sys.argv
    verify = '--verify' in sys.argv

    if verify:
        have = [a for a in KNOWN if has_item(a)]
        print(f"Keychain（服務 {SERVICE}）裡已有密碼的銀行 {len(have)}/{len(KNOWN)}：")
        print('  有：', ', '.join(have) or '（無）')
        print('  無：', ', '.join(a for a in KNOWN if a not in have) or '（無）')
        return

    if not OLD_CONFIG.exists():
        print(f"❌ 找不到 {OLD_CONFIG}")
        print("   沒有舊設定檔的話，請照 README.md 一家一家手動加入。")
        sys.exit(1)

    cfg = json.loads(OLD_CONFIG.read_text(encoding='utf-8-sig'))
    pws = cfg.get('passwords', {})
    if not pws:
        print('舊設定檔裡沒有 passwords 區塊，沒有東西可以匯入。')
        return

    print(f"舊設定檔裡有 {len(pws)} 家銀行的密碼：{', '.join(sorted(pws))}")
    if not write:
        print('\n這是預覽。確定要寫進 Keychain 請加上 --write')
        return

    ok, skip, fail = 0, 0, 0
    for code in sorted(pws):
        value = str(pws[code])
        if not value:
            skip += 1
            continue
        r = subprocess.run(
            ['security', 'add-generic-password',
             '-s', SERVICE, '-a', code, '-w', value,
             '-U',                          # 已存在就更新
             '-T', '/usr/bin/security',     # 只讓 security 這支工具讀，排程才不會跳詢問框
             '-j', f'My Wallet 帳單機器人：{code} 的 PDF 開啟密碼'],
            capture_output=True, text=True)
        if r.returncode == 0:
            print(f"  ✅ {code}")
            ok += 1
        else:
            # 不印 stderr 全文，避免萬一把參數（含密碼）一起印出來
            print(f"  ❌ {code}（security 回傳 {r.returncode}）")
            fail += 1

    print(f"\n完成：成功 {ok}、空值略過 {skip}、失敗 {fail}")
    if ok:
        print("建議接著做：把 Build_Bot_in_windows/config.json 的 passwords 區塊清掉，")
        print("            明文密碼就不再留在硬碟上。")


if __name__ == '__main__':
    main()
