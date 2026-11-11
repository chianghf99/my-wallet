// jsc 橋接：讓 Python 排程用到「網頁上那一份」銀行解析規則
//
// 這台機器沒有 node，但 macOS 內建 JavaScriptCore 的 jsc。執行方式（由 bill_bot.py 組出）：
//
//   jsc js/utils/bill-parse.js <暫存的 input.js> scripts/billbot/parse_bridge.js
//
// input.js 由 Python 產生，內容是 `globalThis.__INPUT = {"filename":…,"text":…};`。
// 為什麼不用 jsc 的 readFile() 或命令列參數：兩者在不同 macOS 版本的 jsc 裡名稱與行為
// 不一致（arguments / scriptArgs / readFile 各版不同），把輸入直接編成一個 JS 檔最穩，
// 而且 json.dumps 的輸出本身就是合法的 JS 字面值。
//
// 輸出：最後一行印出 JSON，Python 只讀最後一行（前面若有 jsc 的警告也不會干擾）。

(function () {
    'use strict';
    var input = globalThis.__INPUT || {};
    var out;
    try {
        var r = globalThis.BillParse.processBankRules(input.filename || '', input.text || '');
        out = {
            ok: true,
            bankName: r.bankName,
            amount: r.amount,
            dueDate: r.dueDate,
            // 排程端要把帳單名稱寫進雲端，名稱必須與網頁用同一套正規化規則，
            // 否則同一家銀行會在列表裡出現兩種寫法、也關聯不到卡片。
            officialName: globalThis.BillParse.getOfficialBankName(r.bankName),
            keyword: globalThis.BillParse.getBankKeyword(r.bankName)
        };
    } catch (e) {
        out = { ok: false, error: String(e && e.message || e) };
    }
    print(JSON.stringify(out));
})();
