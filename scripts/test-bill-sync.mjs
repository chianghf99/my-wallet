// 卡片管家「上傳前合併雲端帳單」的回歸測試
//
// 守的是什麼：
// 卡片管家的雲端同步是「整包覆寫 bills 陣列」。排程機器人（scripts/billbot）把新帳單
// 寫進雲端後，一個更早載入的分頁只要在上面改任何東西，那次上傳就會把機器人加的帳單
// 蓋掉。v5.13.0 因此在上傳前先把「雲端有、本機沒有」的帳單併回來。
//
// 這段判斷有兩個**反方向**的失敗模式，而且兩者都不會當場報錯：
//   併得太少 → 默默弄丟別處（另一台裝置或排程）新增的帳單
//   併得太多 → 使用者刪掉的帳單被復活，刪不掉
// 等到被發現時都已經來不及，所以用測試把四種情境釘住。
//
// 測的是網頁實際會載入的那一份原始碼（js/utils/bill-parse.js），不是副本。
// 那個檔案是古典 script（因為 mycreditcard.html 還不是 type="module"，而排程端用 jsc），
// 所以這裡用 new Function 把它跑在一個假的 globalThis 上，再取出它掛上去的 BillParse。
//
// 執行：
//   node scripts/test-bill-sync.mjs
//   本機沒有 node，改用 jsc（它有 readFile，下面的 import('node:fs') 不會被走到）：
//     cat > /tmp/run.mjs <<'EOF'
//     globalThis.console = { log: (...a) => print(a.join(' ')), warn: () => {}, error: (...a) => print(a.join(' ')) };
//     await import('/Users/chiang/Desktop/Mywallet/scripts/test-bill-sync.mjs');
//     EOF
//     /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m /tmp/run.mjs

const SOURCE = 'js/utils/bill-parse.js';

// jsc 有 readFile、沒有 node:fs；node 反之。動態 import 只有在 node 下才會被求值。
const readSource = async (relPath) => {
    if (typeof globalThis.readFile === 'function') {
        // jsc：相對於執行時的工作目錄
        return globalThis.readFile(relPath);
    }
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(repo, relPath), 'utf8');
};

const src = await readSource(SOURCE);
const sandbox = {};
// 參數名刻意叫 globalThis，把檔案裡的 globalThis 指到 sandbox，
// 這樣它掛的是 sandbox.BillParse，不會污染真正的全域。
new Function('globalThis', src)(sandbox);

const { billCreatedAt, rescuableBills } = sandbox.BillParse || {};

let failures = 0;
const expect = (name, actual, want) => {
    const ok = JSON.stringify(actual) === JSON.stringify(want);
    if (!ok) {
        failures++;
        console.log(`❌ ${name}\n     實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(want)}`);
    } else {
        console.log(`✅ ${name}`);
    }
};

if (typeof rescuableBills !== 'function' || typeof billCreatedAt !== 'function') {
    console.log(`❌ ${SOURCE} 沒有匯出 rescuableBills / billCreatedAt`);
    throw new Error('測試無法進行');
}

// --- billCreatedAt ---------------------------------------------------

expect('13 位毫秒 id 解得出建立時間', billCreatedAt('1762800000000'), 1762800000000);
expect('id 後面接了流水號時只取前 13 碼', billCreatedAt('176280000000012'), 1762800000000);
expect('卡片式的亂數後綴也只取前 13 碼', billCreatedAt('1762800000000x7g2k'), 1762800000000);
expect('非數字 id 回 null（當成舊資料，不復活）', billCreatedAt('abc'), null);
expect('空字串回 null', billCreatedAt(''), null);
expect('undefined 回 null', billCreatedAt(undefined), null);
expect('null 回 null', billCreatedAt(null), null);
expect('數字型別的 id 也要能解', billCreatedAt(1762800000000), 1762800000000);

// --- rescuableBills：四種情境 ----------------------------------------

const WATERMARK = 1762800000000;                       // 這台裝置與雲端對齊的時間點
const older = String(WATERMARK - 86400000);            // 對齊前一天建立
const newer = String(WATERMARK + 3600000);             // 對齊後一小時建立（＝排程寫入的）

const localBill = { id: older, name: '玉山銀行', amount: 100, date: '2026-11-20' };
const botBill = { id: newer, name: '聯邦銀行', amount: 6369, date: '2026-11-24' };

// 情境 1：排程在本機對齊之後寫入新帳單 → 必須併回來（這就是這次要修的漏洞）
expect('情境1 排程新增的帳單要併回本機',
    rescuableBills([localBill, botBill], [localBill], WATERMARK), [botBill]);

// 情境 2：使用者在本機刪掉一筆舊帳單 → 絕對不可以復活
expect('情境2 本機刪掉的舊帳單不可復活',
    rescuableBills([localBill], [], WATERMARK), []);

// 情境 3：兩邊都有同一筆（本機可能已改成已繳）→ 不動它，本機版本為準
const paidLocally = { ...localBill, status: 'paid' };
expect('情境3 兩邊都有的帳單以本機為準，不併回舊版',
    rescuableBills([localBill], [paidLocally], WATERMARK), []);

// 情境 4：新裝置（水位線 0，還沒跟雲端對齊過）→ 一律併回來，不替使用者刪東西
expect('情境4 水位線為 0 時全部併回來',
    rescuableBills([localBill, botBill], [], 0), [localBill, botBill]);

// --- 邊界 -------------------------------------------------------------

// 剛好等於水位線的那一刻：視為「對齊時就有了」→ 不復活。
// 這個方向是刻意選的：寧可漏接一筆（下次下載會補回來），也不要讓刪除失效。
expect('建立時間剛好等於水位線 → 不併回來',
    rescuableBills([{ id: String(WATERMARK), name: 'X', amount: 1, date: '' }], [], WATERMARK), []);

expect('雲端沒有 bills 欄位（undefined）不會炸',
    rescuableBills(undefined, [localBill], WATERMARK), []);
expect('雲端 bills 不是陣列（舊壞資料）不會炸',
    rescuableBills({ nope: true }, [localBill], WATERMARK), []);
expect('本機 bills 是 undefined 時仍算得出來',
    rescuableBills([botBill], undefined, WATERMARK), [botBill]);
expect('雲端陣列裡夾著 null 不會炸',
    rescuableBills([null, botBill], [], WATERMARK), [botBill]);
expect('非數字 id 的雲端帳單在水位線之後不會被復活',
    rescuableBills([{ id: 'legacy-bill', name: 'X', amount: 1, date: '' }], [], WATERMARK), []);
expect('watermark 傳 undefined 時當成 0（全部併回來）',
    rescuableBills([localBill], [], undefined), [localBill]);

// id 相同但型別不同不該被當成兩筆 —— 兩個方向都要測。
// 只測一個方向會漏掉：少了其中一邊的 String() 時，另一個方向仍然會通過。
expect('id 型別不同仍視為同一筆（雲端數字、本機字串）',
    rescuableBills([{ id: Number(newer), name: '聯邦銀行', amount: 6369, date: '2026-11-24' }],
                   [{ id: newer, name: '聯邦銀行', amount: 6369, date: '2026-11-24' }],
                   WATERMARK), []);
expect('id 型別不同仍視為同一筆（雲端字串、本機數字）',
    rescuableBills([{ id: newer, name: '聯邦銀行', amount: 6369, date: '2026-11-24' }],
                   [{ id: Number(newer), name: '聯邦銀行', amount: 6369, date: '2026-11-24' }],
                   WATERMARK), []);

console.log(failures === 0
    ? '\n✅ 全部通過'
    : `\n❌ 有 ${failures} 項失敗`);

if (failures > 0) {
    // node 下以非 0 離開碼結束，CI 才會紅；jsc 沒有 process，丟例外即可
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error(`${failures} 項測試失敗`);
}
