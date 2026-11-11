// 帳單共用邏輯 —— 前端與本機排程共用同一份
//
// 內容分兩塊：
//   1. 13 家銀行的帳單 PDF 解析規則（processBankRules 與銀行名稱正規化）
//   2. 雲端同步的合併判斷（billCreatedAt / rescuableBills，見下方該區段的說明）
//
// 為什麼要抽出來：
// 這些規則原本寫在 mycreditcard.html 的 setup() 裡，只有「人在網頁上選檔案」時才跑得到。
// scripts/billbot 要在無人看管的排程裡做同一件事，如果另寫一份 Python 規則，就會變成
// 同一套規則兩份實作 —— 改了網頁沒改排程時，排程會默默解析錯（而且不會報錯，只會寫進
// 錯的金額）。這與 js/utils/valuation.js、futures.js 的處理方式一致：公式只有一份。
//
// 為什麼是「古典 script」而不是 ES module：
// mycreditcard.html 目前還不是 type="module"（見 .claude/progress.md 的階段 2），
// 而排程端是用系統內建的 jsc 執行（這台機器沒有 node）。古典 script 兩邊都載得動：
//   瀏覽器： <script src="js/utils/bill-parse.js"></script>
//   jsc：    jsc js/utils/bill-parse.js scripts/billbot/parse_bridge.js
// 日後 mycreditcard.html 轉成 module 時，這裡只要在檔尾補 export 即可，不必改邏輯。
//
// ⚠️ 關鍵前提：processBankRules 吃的 text 必須是「用 Y 座標分行」的版面文字。
// 華南、第一銀行、國泰的規則都依賴「標籤一行、數字在下一行」的行結構，
// 中信更是靠裸數字的排列來認。瀏覽器端由 pdf.js 的 transform[5] 分行（3pt 一桶），
// 排程端由 pdfplumber 的 extract_words() 以同樣規則重建 —— 兩邊必須一致，
// 不要改成單純的 extract_text()。

(function (root) {
    'use strict';

    const commonBanksList = [
        '中華郵政', '台灣銀行', '土地銀行', '合作金庫', '第一銀行', '華南銀行', '彰化銀行', '上海商業儲蓄銀行', 
        '台北富邦', '國泰世華', '高雄銀行', '兆豐銀行', '花旗銀行', '渣打銀行', '台中銀行', '京城銀行', 
        '瑞興銀行', '華泰銀行', '臺灣新光商業銀行', '陽信銀行', '板信商業銀行', '三信商業銀行', '聯邦銀行', 
        '遠東商銀', '元大銀行', '永豐銀行', '玉山銀行', '凱基銀行', '星展銀行', '台新銀行', '日盛商銀', 
        '安泰銀行', '中國信託', '滙豐銀行', '樂天國際商業銀行', '連線商業銀行', '將來商業銀行'
    ];

    const getBankKeyword = (name) => {
        if (!name) return "";
        const clean = name.toLowerCase().replace(/臺/g, "台").replace(/銀行|商銀|商業銀行|信用卡/g, "").trim();
        
        // Map aliases to keywords
        if (clean.includes("line") || clean.includes("連線")) return "連線";
        if (clean.includes("next") || clean.includes("將來")) return "將來";
        if (clean.includes("rakuten") || clean.includes("樂天")) return "樂天";
        if (clean.includes("hsbc") || clean.includes("滙豐") || clean.includes("匯豐")) return "滙豐";
        if (clean.includes("fubon") || clean.includes("富邦")) return "富邦";
        if (clean.includes("cathay") || clean.includes("國泰")) return "國泰";
        if (clean.includes("taishin") || clean.includes("台新")) return "台新";
        if (clean.includes("esun") || clean.includes("玉山")) return "玉山";
        if (clean.includes("ctbc") || clean.includes("中信") || clean.includes("中國信託")) return "中信";
        
        const keywords = [
            "富邦", "國泰", "台新", "玉山", "中信", "中國信託", "永豐", "兆豐", "聯邦", "元大", 
            "第一", "華南", "彰化", "彰銀", "合作金庫", "合庫", "土地", "土銀", "上海", 
            "星展", "花旗", "渣打", "滙豐", "匯豐", "新光", "遠東", "凱基", "陽信", "台中",
            "郵局", "郵政", "中華郵政", "將來", "連線", "樂天", "台企銀", "臺灣企銀", "台灣企銀",
            "高雄", "京城", "瑞興", "華泰", "板信", "三信", "安泰", "日盛", "台灣", "台銀"
        ];
        for (const kw of keywords) {
            if (clean.includes(kw.toLowerCase())) {
                if (kw === "中國信託") return "中信";
                if (kw === "彰銀") return "彰化";
                if (kw === "合庫") return "合作金庫";
                if (kw === "土銀") return "土地";
                if (kw === "台銀") return "台灣";
                if (kw === "郵局") return "郵政";
                if (kw === "中華郵政") return "郵政";
                return kw;
            }
        }
        return clean.substring(0, 2);
    };

    const getOfficialBankName = (name) => {
        if (!name) return "其他";
        const kw = getBankKeyword(name);
        if (!kw) return name;
        if (kw === "中信") return "中國信託";
        const found = commonBanksList.find(b => b.includes(kw) || kw.includes(b));
        if (found) return found;
        return kw;
    };

    const processBankRules = (filename, text) => {
        let amount = -1; let dueDate = "未知日期"; let bankName = "";
        filename = filename.toLowerCase();
        const textNoSpace = text.replace(/\s+/g, "");
        
        const cleanDate = (dStr) => {
            try {
                dStr = dStr.replace(/[^\d\/-]/g, "");
                let parts = dStr.split(/[\/-]/);
                if (parts.length === 3) {
                    let y = parseInt(parts[0]); if(y < 1000) y += 1911;
                    return `${y}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
                }
                return dStr;
            } catch(e) { return dStr; }
        };

        // 1. 星展銀行
        if (filename.includes("cbgcc") || filename.includes("dbs") || filename.includes("星展")) {
            bankName = "星展信用卡";
            let allDates = text.match(/\d{4}\/\d{2}\/\d{2}/g);
            if (allDates) dueDate = cleanDate(allDates.sort().pop());
            let autoPayMatch = text.match(/自動扣繳\s*(\d{1,3}(?:,\d{3})*)/);
            if (autoPayMatch) amount = parseInt(autoPayMatch[1].replace(/,/g, ""));
        } 
        // 2. 富邦學貸
        else if (filename.includes("就學貸款")) {
            bankName = "富邦學貸";
            let amtMatch = text.match(/本期應繳總金額\s*(\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
            let dateMatch = text.match(/扣繳日期.*?(\d{3}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[1]);
        }
        // 3. 永豐銀行
        else if (filename.includes("永豐") || filename.includes("sinopac")) {
            bankName = "永豐信用卡";
            let dateMatch = text.match(/截止日\s*[:]?\s*(\d{4}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[1]);
            let deductMatch = text.match(/預定扣款金額\s*(\d{1,3}(?:,\d{3})*)/) || text.match(/(?<!上期)應繳總金額\s*(\d{1,3}(?:,\d{3})*)/);
            if (deductMatch) amount = parseInt(deductMatch[1].replace(/,/g, ""));
        }
        // 4. 富邦信用卡
        else if (filename.includes("富邦") || /^\d+年\d+月/.test(filename)) {
            bankName = "富邦信用卡";
            let dateMatch = text.match(/(\d{3}\/\d{2}\/\d{2})\s+(\d{3}\/\d{2}\/\d{2})/) || text.match(/繳款截止日\s*(\d{2,3}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[dateMatch.length - 1]);
            let amtMatch = textNoSpace.match(/本期應繳總額(\d{1,3}(?:,\d{3})*)/) || textNoSpace.match(/NT\$(\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
        }
        // 5. 台新銀行
        else if (filename.includes("台新") || filename.includes("tsb")) {
            bankName = "台新信用卡";
            let dateMatch = text.match(/繳款截止日\s*(\d{2,3}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[1]);
            let amtMatch = text.match(/本期累計應繳金額\s*(\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
        }
        // 6. 國泰世華
        // parsePDF 已改用 Y 座標分行，文字結構與 pdfplumber 一致，可用行分割法
        else if (filename.includes("國泰") || filename.includes("消費明細")) {
            bankName = "國泰信用卡";
            const lines = text.split('\n').map(line => line.trim());
            // 找出所有獨立行日期，取 ISO 最大的（截止日 > 結帳日）
            const standaloneDates = [];
            for (let i = 0; i < lines.length; i++) {
                if (/^\d{3,4}\/\d{2}\/\d{2}$/.test(lines[i])) {
                    standaloneDates.push({ idx: i, iso: cleanDate(lines[i]) });
                }
            }
            if (standaloneDates.length > 0) {
                const latest = standaloneDates.reduce((a, b) => a.iso > b.iso ? a : b);
                dueDate = latest.iso;

                // 從截止日後最多 15 行內找金額
                // 國泰帳單中「應繳總額」與「預借現金額度(>=100000)」在同一行
                // 策略 A：找含有巨大數字(>=100000)的行，同行最小有效數字即為應繳金額
                // 策略 B：fallback 取所有候選中的最大值（總額 > 最低應繳）
                const candidates = [];
                let found = false;
                for (let j = latest.idx + 1; j < Math.min(latest.idx + 15, lines.length); j++) {
                    // 彈性抽取：同時接受含逗號與不含逗號的數字
                    const nums = [];
                    for (const m of lines[j].matchAll(/\b\d[\d,]*\b/g)) {
                        const v = parseInt(m[0].replace(/,/g, ""));
                        if (!isNaN(v)) nums.push(v);
                    }
                    if (nums.length === 0) continue;

                    // 策略 A：同行有 >=100,000 的大數字 → 取最小有效值
                    if (nums.some(n => n >= 100000)) {
                        const valid = nums.filter(n => n >= 100 && n < 100000 && n % 10000 !== 0);
                        if (valid.length > 0) {
                            amount = Math.min(...valid); // 有效候選中最小的（排除額度）
                            found = true;
                            break;
                        }
                    } else {
                        // 收集一般候選（供策略 B 用）
                        nums.filter(n => n >= 500 && n < 100000 && n % 10000 !== 0)
                            .forEach(n => candidates.push(n));
                    }
                }
                // 策略 B：沒找到伴隨大數字的行，取候選最大值（總額 > 最低應繳）
                if (!found && candidates.length > 0) {
                    amount = Math.max(...candidates);
                }
            }
        }
        // 7. 彰化銀行
        else if (filename.includes("彰化") || filename.includes("chb")) {
            bankName = "彰銀信用卡";
            let dateMatch = text.match(/截止日[\s\S]{0,30}(\d{4}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[1]);
            let amtMatch = text.match(/本期應繳總額.*?[=]\s*(\d{1,3}(?:,\d{3})*)/) || text.match(/[=]\s*(\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
        }
        // 8. 玉山銀行
        else if (filename.includes("玉山") || filename.includes("esun")) {
            bankName = "玉山信用卡";
            let allDates = text.match(/\d{3}\/\d{2}\/\d{2}/g);
            if (allDates) {
                let validDates = allDates.filter(d => d.startsWith("11"));
                if (validDates.length) dueDate = cleanDate(validDates.sort().pop());
            }
            let amtMatch = textNoSpace.match(/本期應繳總金額[：:]?(?:TWD|NT\$|twd|nt\$)?(\d{1,3}(?:,\d{3})*)/i) || 
                           textNoSpace.match(/本期應繳總金額(\d{1,3}(?:,\d{3})*)元/) ||
                           textNoSpace.match(/(\d{1,3}(?:,\d{3})*)元(\d{1,3}(?:,\d{3})*)元/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
        }
        // 9. 聯邦銀行
        else if (filename.includes("聯邦") || filename.includes("ubot")) {
            bankName = "聯邦信用卡";
            let amtMatch = textNoSpace.match(/之信用卡消費帳單[：:](\d{1,3}(?:,\d{3})*)/) || text.match(/(\d{1,3}(?:,\d{3})*).*?優惠注意事項/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
            
            let idx = textNoSpace.indexOf("之信用卡消費帳單：");
            if (idx === -1) idx = textNoSpace.indexOf("之信用卡消費帳單:");
            if (idx !== -1) {
                let dateMatch = textNoSpace.substring(idx).match(/\d{3}\/\d{2}\/\d{2}/);
                if (dateMatch) dueDate = cleanDate(dateMatch[0]);
            } else {
                let allDates = text.match(/\d{3}\/\d{2}\/\d{2}/g);
                if (allDates) dueDate = cleanDate(allDates.sort().pop());
            }
        }
        // 10. 中國信託
        else if (filename.includes("ctbc") || filename.includes("中信")) {
            bankName = "中信信用卡";
            let allDates = text.match(/(\d{3}\s\d{2}\s\d{2})|(\d{3}\/\d{2}\/\d{2})/g);
            if (allDates) {
                let validDates = allDates.filter(d => d.includes("114") || d.includes("115"));
                if (validDates.length) dueDate = cleanDate(validDates.sort().pop());
            }
            let amtMatch = text.match(/\$\s*(\d{1,3}(?:,\d{3})*)/g);
            if (amtMatch) {
                let nums = amtMatch.map(m => parseInt(m.replace(/[$,]/g, "")));
                amount = Math.max(...nums);
            }
            // 0 元帳單的兜底判定。
            // 中信的 PDF 用自訂字型，pdf.js 抽不出任何中文，也沒有 $ 符號 ——
            // 版面只剩一堆裸數字，沒有「本期應繳總金額」這類標籤可定位，
            // 只能靠 0 元版面特有的「/ 0 / 0」與「0 +0」兩個圖樣來認。
            // 原本用 includes 寫死單一空格，但上面的分行是把每個 text item 用 " " 串起來，
            // 而中信每個字元自成一個 item，實際長相是「/   0   /   0」——
            // 所以這兩個判定從來沒成立過。改用容許任意空白的 regex。
            if (amount === -1 && (/\/\s*0\s*\/\s*0/.test(text) || /\s0\s+\+\s*0(?!\d)/.test(text))) amount = 0;
        }
        // 11. 新光銀行 (檔名: 信用卡帳單YYYY年M月.pdf)
        else if (filename.includes("新光") || /信用卡帳單\d+年\d+月/.test(filename)) {
            bankName = "新光信用卡";
            const textNS = text.replace(/[\s\n\r]/g, "");
            let dateMatch = textNS.match(/繳款截止日(\d{2,3}\/\d{2}\/\d{2})/);
            if (dateMatch) dueDate = cleanDate(dateMatch[1]);
            let amtMatch = textNS.match(/本期應繳總金額(\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) amount = parseInt(amtMatch[1].replace(/,/g, ""));
        }
        // 12. 華南銀行 (檔名: CREDITA + 日期流水號.pdf)
        else if (filename.includes("credita") || filename.includes("華南") || filename.includes("hncb")) {
            bankName = "華南信用卡";
            // 金額：華南表頭是「上期應繳總額 - 繳款金額 - 調整/退貨金額 + 本期新增款項
            // = 本期應繳總額 本期最低應繳金額」一整列標籤，數字全在「下一行」，
            // 所以標籤後面直接接數字的寫法在華南是抓不到的。
            // 真正標籤與金額同一行的只有消費明細最後那列「本期應繳總額： 162」，優先用它。
            let amtMatch = textNoSpace.match(/本期應繳總額[：:](-?\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) {
                amount = parseInt(amtMatch[1].replace(/,/g, ""));
                // 上期溢繳時本期應繳會是負數（例：-36），代表這期不用繳，記 0。
                if (amount < 0) amount = 0;
            } else {
                // 兜底：找表頭那列標籤，取下一行的數字列。
                // 該列固定六個數字（上期應繳、繳款、調整/退貨、本期新增、本期應繳、最低應繳），
                // 本期應繳總額固定是倒數第二個。
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && amount === -1; i++) {
                    if (!lines[i].replace(/\s+/g, "").includes("本期應繳總額本期最低應繳金額")) continue;
                    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                        const nums = (lines[j].match(/-?\d[\d,]*/g) || []).map(n => parseInt(n.replace(/,/g, "")));
                        if (nums.length >= 5) {
                            amount = Math.max(nums[nums.length - 2], 0);
                            break;
                        }
                    }
                }
            }
            // 日期：表頭的「帳單結帳日 繳款截止日 …」同樣是標籤一行、日期一行，
            // 而且整份帳單裡「115/12/31」（紅利到期日）比截止日還晚 ——
            // 取最大日期會抓錯，必須靠位置定位。
            // 第 3 頁繳款單的「繳款期限：115/09/07」是標籤與日期同一行，最可靠。
            let dueMatch = textNoSpace.match(/繳款期限[：:]?(\d{3}\/\d{2}\/\d{2})/);
            if (dueMatch) dueDate = cleanDate(dueMatch[1]);
            else {
                // 兜底（帳單頁數多到第 3 頁不是繳款單時）：表頭標籤列的下一行，
                // 第一個日期是結帳日、第二個才是繳款截止日。
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && dueDate === "未知日期"; i++) {
                    const ns = lines[i].replace(/\s+/g, "");
                    if (!(ns.includes("帳單結帳日") && ns.includes("繳款截止日"))) continue;
                    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                        const dates = lines[j].match(/\d{3}\/\d{2}\/\d{2}/g);
                        if (dates && dates.length >= 2) { dueDate = cleanDate(dates[1]); break; }
                    }
                }
            }
        }
        // 13. 第一銀行 (檔名: 第一銀行電子對帳單YYYY年MM月.pdf)
        else if (filename.includes("第一銀行") || filename.includes("第一銀") || filename.includes("一銀")
                 || filename.includes("firstbank") || /電子對帳單\d+年\d+月/.test(filename)) {
            bankName = "第一信用卡";
            // 金額：第 2 頁繳款聯的「□應繳總額：193」是唯一標籤緊接數字的位置。
            // 不用第 2 頁的「您的本期金額總計」——那是本期新增消費的小計，
            // 上期有未繳款或有回饋折抵時會跟真正的應繳金額對不起來。
            // 第 1 頁的「本期應繳總額 您已辦妥自動扣繳 193」中間夾著扣繳狀態文字，
            // 標籤與數字之間隔著中文，直接接數字的寫法也抓不到。
            let amtMatch = textNoSpace.match(/應繳總額[：:](-?\d{1,3}(?:,\d{3})*)/);
            if (amtMatch) {
                amount = parseInt(amtMatch[1].replace(/,/g, ""));
                if (amount < 0) amount = 0; // 溢繳導致本期應繳為負數時視為不用繳
            } else {
                // 兜底：第 2 頁的計算列
                // 「幣別 上期應繳金額 －已繳金額 ＋本期新增金額 ＋回饋及調整 ＝本期應繳金額 帳單結帳日期」，
                // 數值在下一行（例：新臺幣 0 0 193 0 193 115/09/03）。
                // 該行結尾的帳單結帳日期也是數字，必須先把日期拿掉，剩下的最後一個數字才是本期應繳金額。
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && amount === -1; i++) {
                    if (!lines[i].replace(/\s+/g, "").includes("本期應繳金額")) continue;
                    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                        const nums = (lines[j].replace(/\d{3}\/\d{2}\/\d{2}/g, " ").match(/-?\d[\d,]*/g) || [])
                            .map(n => parseInt(n.replace(/,/g, "")));
                        if (nums.length >= 4) { amount = Math.max(nums[nums.length - 1], 0); break; }
                    }
                }
            }
            // 日期：辦了自動扣繳的帳單會寫「本期將於 115/09/18 由帳號 …… 自動扣繳」，
            // 這是全份帳單裡唯一「繳款日期」與說明同一行的地方，最好認。
            let dueMatch = textNoSpace.match(/本期將於(\d{3}\/\d{2}\/\d{2})/)
                        || textNoSpace.match(/繳款截止日[：:]?(\d{3}\/\d{2}\/\d{2})/);
            if (dueMatch) dueDate = cleanDate(dueMatch[1]);
            else {
                // 兜底：整份帳單只有結帳日與繳款截止日兩種民國日期，
                // 先從計算列尾端取結帳日（115/09/03），再取「比結帳日晚的最早一個日期」當截止日。
                // 不直接取最大值——萬一帳單印了更晚的活動或分期日期會抓錯；
                // 真的找不到結帳日時才退回取最大值。
                const roc = text.match(/\d{3}\/\d{2}\/\d{2}/g) || [];
                if (roc.length) {
                    const isoAll = [...new Set(roc.map(cleanDate))].sort();
                    let stmtIso = "";
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length && !stmtIso; i++) {
                        if (!lines[i].replace(/\s+/g, "").includes("帳單結帳日期")) continue;
                        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
                            const ds = lines[j].match(/\d{3}\/\d{2}\/\d{2}/g);
                            if (ds) { stmtIso = cleanDate(ds[ds.length - 1]); break; }
                        }
                    }
                    const after = stmtIso ? isoAll.filter(d => d > stmtIso) : [];
                    dueDate = after.length ? after[0] : isoAll[isoAll.length - 1];
                }
            }
        }
        
        return { amount, dueDate, bankName: bankName || "未知銀行" };
    };
    // ===================================================================
    // 雲端同步的合併判斷
    //
    // 卡片管家的上傳是「整包覆寫 bills 陣列」。排程機器人（scripts/billbot）寫進雲端後，
    // 一個更早載入的分頁只要在上面改任何東西，那次上傳就會把機器人加的帳單蓋掉 ——
    // 而且沒有任何徵兆。所以上傳前要先把「雲端有、本機沒有」的帳單併回來。
    //
    // 但不能無條件併：那會讓使用者刪掉的帳單復活（雲端還有，本機沒有，看起來一模一樣）。
    // 分辨的依據是帳單 id —— 它就是建立當下的 Date.now()，所以本身即建立時間：
    //   建立時間 > 本機水位線 → 這台裝置與雲端對齊「之後」才在別處新增的 → 併回來
    //   建立時間 ≤ 本機水位線 → 這台裝置本來就有、是被刪掉的 → 不可以復活
    //
    // 這兩個函式放在這裡（而不是留在 mycreditcard.html）的唯一理由是**要測得到**：
    // 判斷寫錯不會當場報錯，只會默默弄丟帳單或讓刪除失效。
    // scripts/test-bill-sync.mjs 在 CI 守住四種情境。
    // ===================================================================

    // 取前 13 碼是容錯：萬一 id 後面被接了流水號或亂數，前 13 碼仍是毫秒時間。
    // 解析不出數字的（極舊或手動造的資料）回傳 null，呼叫端一律當成「舊的」——
    // 寧可讓一筆沒看過的帳單漏接（下次下載就補回來），也不要讓刪除失效。
    const billCreatedAt = (id) => {
        const n = Number(String(id === null || id === undefined ? '' : id).slice(0, 13));
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    // 回傳「雲端有、本機沒有，且應該併回本機」的帳單。
    // watermark 為 0 代表這台裝置還沒跟雲端對齊過（新裝置、或剛清掉 localStorage），
    // 此時一律併回來 —— 寧可多出幾筆讓使用者自己刪，也不要替他刪掉沒見過的資料。
    const rescuableBills = (cloudBills, localBills, watermark) => {
        const cloud = Array.isArray(cloudBills) ? cloudBills : [];
        const localIds = new Set((Array.isArray(localBills) ? localBills : [])
            .map((b) => String(b && b.id)));
        const mark = Number(watermark) || 0;
        return cloud.filter((cb) => {
            if (!cb || localIds.has(String(cb.id))) return false;   // 兩邊都有 → 本機版本為準
            if (mark === 0) return true;
            const createdAt = billCreatedAt(cb.id);
            return createdAt !== null && createdAt > mark;
        });
    };

    root.BillParse = { commonBanksList, getBankKeyword, getOfficialBankName, processBankRules,
                       billCreatedAt, rescuableBills };
})(typeof globalThis !== 'undefined' ? globalThis : this);
