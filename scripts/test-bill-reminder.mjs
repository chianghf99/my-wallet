// 帳單到期提醒的回歸測試
//
// 守的是什麼：
// 這個提醒失敗時不會有任何徵兆 —— 它不會噴錯，只是安靜地不出現，或是把天數算錯
// 一天。等到發現時已經是帳單逾期了。三件事釘在這裡：
//
//   1. 天數算法不可以再踩時區的坑。網頁原本用 new Date('YYYY-MM-DD') 減本地午夜，
//      在台北（UTC+8）整個倒數會多出一天：當天到期顯示「剩 1 天」、逾期一天才顯示
//      「今天到期」。提醒要是也這樣算，就會晚一天通知。
//   2. 該提醒的不可以漏掉（未繳的判定、逾期、繳款日不明）。
//   3. 不該外送的個資不可以混進訊息 —— 自動扣款帳戶末五碼永遠不能出現在推播裡，
//      訊息會經過 Telegram 的伺服器。
//
// 執行：
//   node scripts/test-bill-reminder.mjs
//   本機沒有 node，改用 jsc：
//     cat > /tmp/run.mjs <<'EOF'
//     globalThis.console = { log: (...a) => print(a.join(' ')), warn: () => {}, error: (...a) => print(a.join(' ')) };
//     await import('/Users/chiang/Desktop/Mywallet/scripts/test-bill-reminder.mjs');
//     EOF
//     /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m /tmp/run.mjs

import { parseYMD, daysUntil, hasAutopay, selectBills, buildMessage, totalCount, pickUid,
         DEFAULT_REMIND_DAYS, DEFAULT_OVERDUE_MAX_DAYS } from './bill-reminder-core.mjs';

let failures = 0;
const expect = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
        failures++;
        console.log(`❌ ${name}\n   得到 ${g}\n   期望 ${w}`);
    } else {
        console.log(`✅ ${name}`);
    }
};
const expectTrue = (name, got) => expect(name, Boolean(got), true);

// --- parseYMD ---------------------------------------------------------

expect('正常日期解得出來', parseYMD('2026-11-12'), Date.UTC(2026, 10, 12));
expect('個位數月份日期補不補零都收', parseYMD('2026-1-5'), Date.UTC(2026, 0, 5));
expect('前後空白要容忍', parseYMD(' 2026-11-12 '), Date.UTC(2026, 10, 12));
expect('未知日期回 null', parseYMD('未知日期'), null);
expect('空字串回 null', parseYMD(''), null);
expect('null 回 null', parseYMD(null), null);
expect('undefined 回 null', parseYMD(undefined), null);
expect('不存在的日期回 null，不可以默默進位', parseYMD('2026-02-30'), null);
expect('13 月回 null', parseYMD('2026-13-01'), null);
expect('含時間的字串回 null', parseYMD('2026-11-12T00:00:00Z'), null);

// --- daysUntil：時區那一關 --------------------------------------------

const TODAY = '2026-11-12';
expect('當天到期是 0 天（不是 1 天 —— 這題就是在擋時區的坑）', daysUntil('2026-11-12', TODAY), 0);
expect('明天到期是 1 天', daysUntil('2026-11-13', TODAY), 1);
expect('三天後是 3 天', daysUntil('2026-11-15', TODAY), 3);
expect('昨天到期是 -1 天', daysUntil('2026-11-11', TODAY), -1);
expect('跨月照樣對', daysUntil('2026-12-01', TODAY), 19);
expect('跨年照樣對', daysUntil('2027-01-01', '2026-12-31'), 1);
expect('閏年 2/29 照樣對', daysUntil('2028-03-01', '2028-02-28'), 2);
expect('算不出來回 null', daysUntil('未知日期', TODAY), null);

// --- hasAutopay -------------------------------------------------------

const CARDS = [
    { name: '國泰世華', autopayFrom: '12345' },
    { name: '台新銀行' },                       // 有卡沒設自動扣繳
];
expectTrue('卡片有設自動扣繳就回 true', hasAutopay('國泰世華信用卡帳單', CARDS));
expect('卡片沒設自動扣繳回 false', hasAutopay('台新銀行帳單', CARDS), false);
expect('找不到對應卡片回 false', hasAutopay('玉山銀行帳單', CARDS), false);
expect('帳單沒有名字回 false', hasAutopay('', CARDS), false);
expect('沒有卡片陣列也不可以爆炸', hasAutopay('國泰世華', undefined), false);

// --- selectBills ------------------------------------------------------

const bill = (over) => ({ id: '1', name: '玉山銀行', amount: 1000, date: TODAY, status: 'unpaid', ...over });
const pick = (bills, over = {}) => selectBills(bills, { today: TODAY, cards: CARDS, ...over });

expect('預設提醒日是到期前 3 天與 1 天', DEFAULT_REMIND_DAYS, [3, 1]);

expect('到期前 3 天要提醒', pick([bill({ date: '2026-11-15' })]).dueSoon.length, 1);
expect('到期前 2 天不提醒（避免連三天洗版）', pick([bill({ date: '2026-11-14' })]).dueSoon.length, 0);
expect('到期前 1 天要提醒', pick([bill({ date: '2026-11-13' })]).dueSoon.length, 1);
expect('當天一定提醒，不受 remindDays 影響',
    pick([bill({ date: TODAY })], { remindDays: [7] }).dueToday.length, 1);
expect('逾期要提醒', pick([bill({ date: '2026-11-10' })]).overdue.length, 1);

expect('已繳的不提醒', totalCount(pick([bill({ status: 'paid' })])), 0);
expect('跳過的不提醒', totalCount(pick([bill({ status: 'skipped' })])), 0);
expect('沒有 status 的當成未繳（寧可多吵也不要漏掉要繳的錢）',
    pick([bill({ status: undefined })]).dueToday.length, 1);

expect('金額 0 不提醒（上期溢繳會記成 0，沒有東西要繳）',
    totalCount(pick([bill({ amount: 0 })])), 0);
expect('金額是字串也要認得', pick([bill({ amount: '1500' })]).dueToday.length, 1);

expect('逾期上限預設 60 天', DEFAULT_OVERDUE_MAX_DAYS, 60);
expect('逾期 60 天還在提醒範圍', pick([bill({ date: '2026-09-13' })]).overdue.length, 1);
expect('逾期 61 天就不再提醒（那是沒整理的舊資料，不是待辦）',
    totalCount(pick([bill({ date: '2026-09-12' })])), 0);

expect('繳款日不明歸到 unknownDate', pick([bill({ date: '未知日期' })]).unknownDate.length, 1);
expect('繳款日不明可以關掉',
    totalCount(pick([bill({ date: '未知日期' })], { remindUnknownDate: false })), 0);

expect('自動扣繳的卡會被標記',
    pick([bill({ name: '國泰世華', date: TODAY })]).dueToday[0].autopay, true);

const sorted = pick([
    bill({ id: 'a', date: '2026-11-15' }),
    bill({ id: 'b', date: '2026-11-13' }),
]).dueSoon.map(e => e.days);
expect('快到期的排前面', sorted, [1, 3]);

expect('沒有帳單時四組都空', totalCount(pick([])), 0);
expect('bills 不是陣列也不可以爆炸', totalCount(selectBills(null, { today: TODAY })), 0);
expect('today 不合法時回空（寧可不發，也不要發錯的）',
    totalCount(selectBills([bill()], { today: '壞掉的日期' })), 0);

// --- buildMessage -----------------------------------------------------

expect('沒東西提醒就回 null（代表今天不發）', buildMessage(pick([])), null);

const groups = pick([
    bill({ id: 'a', name: '國泰世華', amount: 12345, date: TODAY }),
    bill({ id: 'b', name: '台新銀行', amount: 6789, date: '2026-11-15' }),
    bill({ id: 'c', name: '玉山銀行', amount: 1000, date: '2026-11-09' }),
]);
const full = buildMessage(groups, { detail: 'full', url: 'https://example.invalid/x' });

expectTrue('完整模式寫得出金額', full.includes('$12,345'));
expectTrue('完整模式寫得出銀行', full.includes('國泰世華'));
expectTrue('完整模式標得出自動扣繳', full.includes('自動扣繳'));
expectTrue('逾期天數寫得出來', full.includes('逾期 3 天'));
expectTrue('連結附在最後', full.includes('https://example.invalid/x'));

// 這一題是隱私底線：扣款帳戶末五碼永遠不可以出現在推播訊息裡
expect('自動扣款帳戶末五碼不可以出現在訊息裡', full.includes('12345'), false);

const counts = buildMessage(groups, { detail: 'counts' });
expect('精簡模式不可以有金額', counts.includes('6,789'), false);
expect('精簡模式不可以有銀行名稱', counts.includes('國泰世華'), false);
expectTrue('精簡模式講得出總筆數', counts.includes('3 筆'));

// 同一天到期的要併成一段，不要每筆各開一個標題
const sameDay = buildMessage(pick([
    bill({ id: 'a', name: '富邦銀行', amount: 100, date: '2026-11-15' }),
    bill({ id: 'b', name: '聯邦銀行', amount: 200, date: '2026-11-15' }),
]), { detail: 'full' });
expect('同一天到期只開一個標題', sameDay.split('還有 3 天').length - 1, 1);

// Telegram 用 parse_mode: HTML，銀行名稱裡的角括號會讓整則訊息送不出去
const escaped = buildMessage(pick([bill({ name: '<b>假銀行</b>', amount: 1, date: TODAY })]), { detail: 'full' });
expectTrue('名稱裡的 HTML 要跳脫掉', escaped.includes('&lt;b&gt;假銀行&lt;/b&gt;'));


// --- pickUid：要提醒哪一組帳號 ----------------------------------------
//
// 這一段是實際踩過的坑：APP_UID 裡放了多組 uid（每日快照會處理多個帳號），
// 提醒卻只有一個 Telegram 收件人，第一次試跑就是在這裡中止的。擋對了 ——
// 沒擋的話會把別人的帳單金額推到使用者手機上 —— 但也因此需要一條指名的路。

const throws = (name, fn, expectInMessage) => {
    let msg = null;
    try { fn(); } catch (e) { msg = e.message; }
    if (msg === null) { failures++; console.log(`❌ ${name}\n   沒有丟例外`); }
    else if (expectInMessage && !msg.includes(expectInMessage)) {
        failures++; console.log(`❌ ${name}\n   訊息是「${msg}」，沒提到「${expectInMessage}」`);
    } else console.log(`✅ ${name}`);
};

expect('APP_UID 只有一組就直接沿用（單一帳號不必多設 secret）', pickUid(undefined, 'uid-a'), 'uid-a');
expect('APP_UID 前後有空白也要修掉', pickUid(undefined, '  uid-a  '), 'uid-a');
expect('REMINDER_UID 優先於 APP_UID', pickUid('uid-b', 'uid-a,uid-c'), 'uid-b');
expect('REMINDER_UID 是空字串時視同沒設', pickUid('   ', 'uid-a'), 'uid-a');

throws('APP_UID 有多組就中止，且訊息要教人怎麼修',
    () => pickUid(undefined, 'uid-a,uid-c'), 'REMINDER_UID');
throws('REMINDER_UID 自己有逗號也要中止',
    () => pickUid('uid-a,uid-b', undefined), 'REMINDER_UID');
throws('兩個都沒設就中止', () => pickUid(undefined, undefined), 'REMINDER_UID');
throws('APP_UID 只有逗號與空白時當成沒設', () => pickUid('', ' , '), 'REMINDER_UID');

console.log(failures === 0
    ? '\n✅ 全部通過'
    : `\n❌ 有 ${failures} 項失敗`);

if (failures > 0) {
    // node 下以非 0 離開碼結束，CI 才會紅；jsc 沒有 process，丟例外即可
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error(`${failures} 項測試失敗`);
}
