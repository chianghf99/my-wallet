// 帳單 PDF 解析規則的回歸測試（js/utils/bill-parse.js 的 processBankRules）
//
// 守的是什麼：
// 這 13 家銀行的規則是「看著真實帳單的版面寫出來的 regex」，而銀行每隔一段時間就會
// 改版。改版造成的失敗**完全沒有徵兆**：
//
//   抓不到日期 → 帳單變成「繳款日不明」，到期提醒無從提醒
//   抓到錯日期 → 更糟，你會照著錯的日子去繳款
//   抓到錯金額 → 最糟，而且直到銀行來催繳才會發現
//
// 所以每次對著真實帳單修好一家，就在這裡留一份「版面結構相同、數字全部換成假的」
// 的樣本釘住。**不要把真實金額或真實繳款日寫進這個檔案** —— my-wallet 是 public repo。
//
// 執行：
//   node scripts/test-bill-parse.mjs

const SOURCE = 'js/utils/bill-parse.js';

const readSource = async (relPath) => {
    if (typeof globalThis.readFile === 'function') return globalThis.readFile(relPath);
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(repo, relPath), 'utf8');
};

const src = await readSource(SOURCE);
const sandbox = {};
new Function('globalThis', src)(sandbox);
const { processBankRules } = sandbox.BillParse || {};

let failures = 0;
const expect = (name, actual, want) => {
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
        failures++;
        console.log(`❌ ${name}\n     實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(want)}`);
    } else {
        console.log(`✅ ${name}`);
    }
};

if (typeof processBankRules !== 'function') {
    console.log('❌ 載不到 processBankRules');
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error('載不到 processBankRules');
}

// --- 玉山銀行 -------------------------------------------------------------
//
// 這家的特別之處：**摘要區的標籤是圖片**。整份 PDF 的文字層裡找不到「繳款截止日」
// 這幾個字（實測第 1 頁只有 50 個詞、7 張圖），所以規則只能從「所有日期」裡挑，
// 沒有標籤可以定位。版面實測結果：
//
//   繳款截止日（上）  2026/07/31 5.88%   ← 旁邊是循環信用年利率
//   結帳日（下）      2026/07/10
//   宣傳行            ※……活動將於 2026/12/31 截止   ← 比繳款日還晚
//
// 挑法因此是「剔掉 ※ 行之後取最晚」。兩個坑都在下面各有一項釘著。

// 版面結構照真實帳單摹寫（數字全部是假的）。各行的意義是靠數值之間的關係反推的：
// 最低應繳約為總額的 16%、額度比總額大一個數量級、額度還會在兩行各出現一次
//（摘要區是圖文表格，pdfplumber 與 pdf.js 都以 Y 座標 3pt 併行，橫向相鄰的格子
// 會被併進同一行）。這些比例刻意保留 —— 樣本如果讓「本期應繳總金額」剛好是
// 最大的數字，就測不出「不可以改成取最大值」。
const esun = [
    '親愛的 王＊明 您好：',
    '這是您 2026年06月 信用卡帳單，感謝您使用電子帳單讓地球更美麗，',
    '敬祝招財納福，Smile每一天！',
    '9,999 元',                      // 本期應繳總金額（大字）
    '9,999 元 165,000 元',           // 同一列：應繳總額 ＋ 總額度
    '2026/07/31 5.88%',              // 繳款截止日 ＋ 循環信用年利率
    '至 2026/08',
    '1,630 元',                      // 本期最低應繳金額（約總額的 16%）
    '17,000 / 165,000 元',           // 可用額度 / 總額度
    '2026/07/10',                    // 結帳日
    '66 點 94 點 777 點 888 點',
    '※您有玉山 e point 即將到期：2026/07共0點、2026/08共0點，將依效期每日到期清除。',
    '※因應台灣高鐵調整合作政策，本行高鐵商務車廂升等活動將於2026/12/31截止;相關退票',
].join('\n');

const esunOut = processBankRules('ESUN_sample.pdf', esun);
expect('玉山：認得出是哪一家', esunOut.bankName, '玉山信用卡');
// 這一項就是 2026/11 那期踩到的坑：規則原本寫死民國年 \d{3}/\d{2}/\d{2}，
// 遇到西元年會在 "2026/07/31" 裡匹配到 "026/07/31"，再被 startsWith("11") 濾掉。
expect('玉山：西元年的繳款日要抓得到（原本會變成未知日期）', esunOut.dueDate, '2026-07-31');
// 這一項守的是「修好年份之後不要反而抓到宣傳行的日期」——
// 12/31 比 07/31 晚，單純 sort().pop() 會挑到它。
expect('玉山：不可以抓到宣傳行裡那個更晚的活動日期', esunOut.dueDate === '2026-12-31', false);
expect('玉山：不可以抓到結帳日', esunOut.dueDate === '2026-07-10', false);
// 金額取摘要區的第一個數值。沒有標籤可以確認它就是「本期應繳總金額」，是靠數值
// 之間的關係間接驗證的：它比最低應繳大約 6 倍、比總額度小一個數量級。
expect('玉山：金額要取本期應繳總金額', esunOut.amount, 9999);
// 這兩項是上面那條推理的反面 —— 擋掉「改成取最大值」與「取到最低應繳」。
// 真實帳單裡額度比應繳總額大 16 倍，取最大值會把額度當成帳單金額。
expect('玉山：不可以取到額度（摘要區最大的數字）', esunOut.amount === 165000, false);
expect('玉山：不可以取到最低應繳金額', esunOut.amount === 1630, false);

// 舊格式（民國年）不可以因為支援西元而壞掉 —— 既有帳單還會被重新解析
const esunRoc = ['這是您 2025年09月 信用卡帳單', '8,888 元', '114/10/28 5.88%', '114/10/13'].join('\n');
expect('玉山：民國年的舊帳單還是解得開', processBankRules('ESUN_old.pdf', esunRoc).dueDate, '2025-10-28');

// --- cleanDate 的年份防線 -------------------------------------------------
//
// 任何一家的規則只要把西元年切成三位數（"2026/07/31" → "026/07/31"），
// +1911 就會變成 1937 年，在網頁上顯示成逾期三萬多天、在提醒裡每天吵。
// 寧可回「未知日期」讓人自己補。
expect('年份不合理時回未知日期，不要回 1937 年',
    processBankRules('ESUN_x.pdf', '026/07/31').dueDate, '未知日期');
expect('年份不合理時回未知日期（民國 26 年同理）',
    processBankRules('ESUN_x.pdf', '26/11/30').dueDate, '未知日期');

// --- 年份防線不可以反過來弄壞其他家 -------------------------------------
//
// cleanDate 回「未知日期」之後，中文字在字串比較上**大於**數字 —— 任何
// 「map(cleanDate) 再取最大值」的規則，只要名單裡混進一個壞日期，取到的就會變成
// 「未知日期」。原本回 1937 年時它排在最小、會被忽略，所以這是加防線**帶出來的**
// 新風險，不是原本就有的。兩家會排序的銀行各釘一項。

// 國泰：獨立行日期取最大，中間混一個壞的
const cathay = ['115/11/13', '115/11/28', '026/07/31'].join('\n');
expect('國泰：壞日期不可以污染「取最晚」的結果',
    processBankRules('國泰_消費明細.pdf', cathay).dueDate, '2026-11-28');

// 第一銀行：兜底路徑（沒有「本期將於」也沒有「繳款截止日」）取最後一個
// 文字裡的 2026/07/31 會被 \d{3}/\d{2}/\d{2} 匹配成 026/07/31 —— 正是這道防線要擋的
const firstbank = ['本期應繳金額', '115/11/28', '2026/07/31'].join('\n');
expect('第一銀行：西元日期被切成三位數時不可以蓋掉正確的那一天',
    processBankRules('第一銀行_電子對帳單.pdf', firstbank).dueDate, '2026-11-28');

console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ 有 ${failures} 項失敗`);
if (failures > 0) {
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error(`${failures} 項測試失敗`);
}
