// 公開日誌遮蔽的回歸測試
//
// 守的是什麼：
// 這個 repo 是 public，Actions 日誌任何人都看得到。排程的每個 console.log 都是
// 人工挑過的（印筆數、印序號），唯一不受控的是最底下 catch 印出來的錯誤 ——
// 那串字是 firebase-admin 給的，裡面會帶含 uid 的 Firestore 文件路徑。
//
// 這個洞的特性是**平常看不到**：只有排程真的壞掉的那一天才會印出來，
// 而那天沒有人會去想「它順手洩漏了什麼」。所以只能靠測試釘住。
//
// 反向保護同樣重要：遮蔽不可以把看得懂的錯誤訊息也一起吃掉，
// 否則壞掉的那天會變成「有擋住，但沒人知道壞在哪」。
//
// 執行：
//   node scripts/test-log-redact.mjs

import { redactLog } from './log-redact.mjs';

let failures = 0;
const expectTrue = (name, cond) => {
    if (cond) { console.log(`  ✓ ${name}`); }
    else { failures++; console.log(`  ✗ ${name}`); }
};

const UID = 'AbCdEfGhIjKlMnOpQrStUvWxYz01';   // 28 碼，Firebase 標準長度（假的）
const OTHER = 'ZzYyXxWw1122334455667788990a'; // 另一個帳號（SNAPSHOT_ALL_USERS 模式會讀到）

console.log('\n— firebase-admin 實際會吐的錯誤格式 —');

// gRPC 格式：uid 出現在 Element 的 name 裡，沒有路徑前綴
const grpc = new Error(
    '5 NOT_FOUND: no entity to update: app: "s~example-project"\n' +
    `path <\n  Element {\n    type: "users"\n    name: "${UID}"\n  }\n>`);
expectTrue('gRPC NOT_FOUND 的 uid 要被遮掉', !redactLog(grpc).includes(UID));
expectTrue('gRPC NOT_FOUND 仍要看得出是 NOT_FOUND', redactLog(grpc).includes('NOT_FOUND'));

// REST 格式：uid 在文件路徑裡
const rest = new Error(
    'Document not found: projects/example-project/databases/(default)' +
    `/documents/users/${UID}/creditcard/data`);
expectTrue('REST 路徑裡的 uid 要被遮掉', !redactLog(rest).includes(UID));
expectTrue('REST 路徑要保留到 users/ 看得出是哪個集合', redactLog(rest).includes('users/<uid>'));

// 多個帳號同時出現（SNAPSHOT_ALL_USERS 模式）
const many = new Error(`failed for users/${UID} and users/${OTHER}`);
expectTrue('第一個 uid 要被遮掉', !redactLog(many).includes(UID));
expectTrue('第二個 uid 也要被遮掉（它不是 secret，GitHub 不會幫你遮）',
    !redactLog(many).includes(OTHER));

// 不是 28 碼的 uid 也要靠路徑規則擋下來
const shortUid = new Error('documents/users/abc123def456/history/2026-11-17');
expectTrue('路徑規則不依賴 uid 長度', !redactLog(shortUid).includes('abc123def456'));

console.log('\n— 傳整個 Error 進去的行為 —');

const withStack = new Error(`boom users/${UID}`);
expectTrue('要取 stack，保留行號方便查問題', redactLog(withStack).includes('test-log-redact'));
expectTrue('stack 裡的 uid 一樣要遮掉', !redactLog(withStack).includes(UID));
expectTrue('非 Error 也要能處理（丟字串、丟 undefined）',
    redactLog('plain string').includes('plain string') && redactLog(undefined) === 'undefined');

console.log('\n— 反向：不可以把看得懂的訊息吃掉 —');

const envMsg = '缺少 FIREBASE_SERVICE_ACCOUNT 環境變數';
expectTrue('環境變數名稱不可以被當成 uid 遮掉', redactLog(new Error(envMsg)).includes(envMsg));

const switchMsg = '若確定要處理專案下所有帳號，請改設 SNAPSHOT_ALL_USERS=true';
expectTrue('SNAPSHOT_ALL_USERS 不可以被遮掉', redactLog(new Error(switchMsg)).includes('SNAPSHOT_ALL_USERS'));

const perm = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
expectTrue('沒有 uid 的錯誤要原封不動', redactLog(perm).includes('Missing or insufficient permissions'));

expectTrue('中文訊息不可以被切壞', redactLog(new Error('找不到卡片管家的資料文件')).includes('找不到卡片管家的資料文件'));

console.log('\n— JSON.parse 不可以回灌金鑰片段 —');
// snapshot.mjs 不再直接 JSON.parse(raw)：V8 會把輸入的前 10 個字放進訊息。
// 這裡釘住那個行為確實存在，免得日後有人覺得那層 try/catch 是多餘的而拿掉。
let v8Echoes = false;
try { JSON.parse('eyJwcml2YXRlX2tleSI6InNlY3JldCJ9'); }
catch (e) { v8Echoes = e.message.includes('eyJwcml2YX'); }
expectTrue('V8 確實會回灌原文前 10 字（所以 snapshot.mjs 必須自己包一層）', v8Echoes);

console.log(failures === 0
    ? '\n✅ 全部通過'
    : `\n❌ 有 ${failures} 項失敗`);

if (failures > 0) {
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error(`${failures} 項測試失敗`);
}
