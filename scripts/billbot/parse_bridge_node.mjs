// Node 橋接：讓 Windows 上的 Python 排程用到「網頁上那一份」銀行解析規則
//
// 與 parse_bridge.js（macOS jsc 用）並存，互不影響。macOS 上的 jsc 路徑不動。
//
// 執行方式（由 bill_bot.py 的 rules_command() 組出）：
//
//   node scripts/billbot/parse_bridge_node.mjs <暫存的 input.js>
//
// input.js 由 Python 產生，內容是 `globalThis.__INPUT = {"filename":…,"text":…};`
// （json.dumps(ensure_ascii=True)，所以檔案本身是純 ASCII，編碼不會出問題）。
//
// 為什麼用 vm.runInThisContext 而不是 ESM import：
// js/utils/bill-parse.js 是古典 script（IIFE 把 BillParse 掛到 globalThis），
// 瀏覽器也是用古典 script 載入它。改成 ESM import 會破壞網頁那一端。
//
// 輸出合約（與 parse_bridge.js 相同，不可以變）：
// 最後一行是 JSON，欄位 ok, bankName, amount, dueDate, officialName, keyword。
// officialName 與 keyword 一定要照 BillParse 的函式取，不可以自己做正規化。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const parseModule = path.resolve(here, '..', '..', 'js', 'utils', 'bill-parse.js');
const inputFile = process.argv[2];

function emit(obj) {
    // 一定用 console.log 印單行 JSON；Python 只讀最後一行
    console.log(JSON.stringify(obj));
}

if (!inputFile) {
    emit({ ok: false, error: 'missing input file argument' });
    process.exit(0);
}

let out;
try {
    // 1. 載入網頁共用的解析規則（古典 script，掛到 globalThis.BillParse）
    vm.runInThisContext(fs.readFileSync(parseModule, 'utf8'), { filename: parseModule });
    // 2. 載入 Python 產生的輸入（設定 globalThis.__INPUT）
    vm.runInThisContext(fs.readFileSync(inputFile, 'utf8'), { filename: inputFile });

    const input = globalThis.__INPUT || {};
    const BP = globalThis.BillParse;
    const r = BP.processBankRules(input.filename || '', input.text || '');
    out = {
        ok: true,
        bankName: r.bankName,
        amount: r.amount,
        dueDate: r.dueDate,
        officialName: BP.getOfficialBankName(r.bankName),
        keyword: BP.getBankKeyword(r.bankName),
    };
} catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
}
emit(out);
