// 卡片管家加解密的黃金樣本（golden sample）回歸測試
//
// 為什麼需要這支：
// mycreditcard.html 的加密邏輯有四代金鑰方案疊在一起，而且全部寫在那個單檔裡、
// 沒辦法 import，所以 v5.10.0 與 v5.11.0 兩次修正都只能靠人工在瀏覽器實測十五種
// 情境。那些驗證沒有留下任何東西，下次改動不會自動攔住回歸 —— 而這是整個 repo 裡
// 最不該靠記憶力守住的部分：改錯不會當場報錯，是等到換裝置登入才發現資料解不開。
//
// 這支測試守的是「既有資料還解得開」這條底線，方式是不信任 CryptoJS、改用
// Node 內建 crypto 獨立重算一次：
//   1. 直接從 mycreditcard.html 原始碼抽出金鑰參數（salt、迭代次數、canary 明文），
//      確認沒有被改掉 —— 改這些等於讓所有既有使用者的資料解不開；
//   2. 用 node:crypto 的 PBKDF2-SHA1 重算金鑰，比對寫死的黃金值；
//   3. 用標準 OpenSSL 流程解開寫死的密文，比對明文。
//
// 第 1 點是關鍵：測試不是對著一份副本跑，而是對著網頁實際會執行的那份原始碼。
// 有人把 iterations 從 10000 改成 100000，這裡就會紅。
//
// 黃金值的來源：在瀏覽器用網頁實際載入的那版 CryptoJS (4.1.1) 產生，並已用
// 瀏覽器內建的 WebCrypto PBKDF2-SHA1 交叉驗證過 CryptoJS 的輸出與標準實作一致。
//
// 執行：node scripts/test-card-crypto.mjs
// （這支會 import node:crypto，所以不像另外兩支可以用 jsc 跑）

import { readFileSync } from 'node:fs';
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'mycreditcard.html'), 'utf8');

let failures = 0;
const expect = (name, actual, want) => {
    const ok = JSON.stringify(actual) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`❌ ${name}\n     實得 ${JSON.stringify(actual)}\n     期望 ${JSON.stringify(want)}`); }
    else console.log(`✅ ${name}`);
};

// --- CryptoJS.AES.encrypt(text, passphraseString) 的格式 ---
// 傳字串當金鑰時走的是 OpenSSL 相容格式：
//   base64( "Salted__" + 8 bytes salt + AES-256-CBC 密文 )
// 金鑰與 IV 由 EVP_BytesToKey(MD5, passphrase, salt) 推導。
// 這裡自己實作一次，不裝 crypto-js —— 既少一個相依套件，也順便證明使用者的資料
// 沒有被鎖死在 CryptoJS，用任何標準工具都解得開。
const evpBytesToKey = (passphrase, salt) => {
    const pass = Buffer.from(passphrase, 'binary');
    let data = Buffer.alloc(0), prev = Buffer.alloc(0);
    while (data.length < 48) {                       // 32 bytes key + 16 bytes IV
        prev = createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
        data = Buffer.concat([data, prev]);
    }
    return { key: data.subarray(0, 32), iv: data.subarray(32, 48) };
};

const cryptoJsDecrypt = (ciphertextB64, passphrase) => {
    const raw = Buffer.from(ciphertextB64, 'base64');
    if (raw.subarray(0, 8).toString('utf8') !== 'Salted__') throw new Error('不是 OpenSSL Salted__ 格式');
    const { key, iv } = evpBytesToKey(passphrase, raw.subarray(8, 16));
    const d = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
};

// --- 1. 原始碼裡的金鑰參數不可被改動 ---
// 改掉其中任何一項，既有使用者的 enc_* 就再也解不開（而且不會當場報錯）。
const grab = (re, label) => {
    const m = HTML.match(re);
    if (!m) { failures++; console.log(`❌ 在 mycreditcard.html 找不到${label}，測試無法確認網頁實際用的參數`); return null; }
    return m[1];
};

expect('舊制固定 salt 未被更動',
    grab(/const _FIXED_SALT = '([^']+)'/, '_FIXED_SALT'), 'mywallet-pbkdf2-v2');
expect('PIN 金鑰迭代次數未被更動',
    grab(/const deriveKey = \(pin\) => \{[\s\S]*?iterations: (\d+)/, 'deriveKey 的 iterations'), '10000');
expect('主密碼金鑰迭代次數未被更動',
    grab(/const deriveMasterKey = \(passphrase, salt\) => \{[\s\S]*?iterations: (\d+)/, 'deriveMasterKey 的 iterations'), '210000');
expect('canary 明文未被更動',
    grab(/const KEY_CHECK_PLAINTEXT = '([^']+)'/, 'KEY_CHECK_PLAINTEXT'), 'mywallet-key-check-v1');

// --- 2. 金鑰推導結果必須與黃金值逐字相同 ---
// 以 node:crypto 獨立重算，不經過 CryptoJS。
const FIXED_SALT = 'mywallet-pbkdf2-v2';
const derivePin = (pin) => pbkdf2Sync(pin, FIXED_SALT, 10000, 32, 'sha1').toString('hex');
const deriveMaster = (pass, salt) => pbkdf2Sync(pass, salt, 210000, 32, 'sha1').toString('hex');

const PIN_KEY = '25ea90db87f38a2593ed7ab6981d8a938f2b81d37a6ac668f3e7d00caed20c54';
const PASS_KEY = 'ebbda714f97c1647f68fab129fdc83519033847717340fd3ce8db0ed698a25b2';

expect('PIN 123456 推導出的金鑰', derivePin('123456'), PIN_KEY);
expect('主密碼推導出的金鑰', deriveMaster('correct-horse-battery', 'GOLDEN-SALT-V1'), PASS_KEY);

// PIN 差一位就要是完全不同的金鑰（確認 salt 真的有被帶進去、不是回傳常數）
if (derivePin('123457') === PIN_KEY) { failures++; console.log('❌ 不同 PIN 推出相同金鑰'); }
else console.log('✅ 不同 PIN 推出不同金鑰');

// --- 3. 既有密文必須解得開，且解出來逐字相同 ---
// 這幾筆密文是用網頁實際載入的 CryptoJS 4.1.1 產生後寫死的，代表「使用者硬碟與
// 雲端上已經存在的資料」。任何改動都不該讓這幾筆解不開。
const GOLDEN = [
    { key: PIN_KEY,  plain: '台北市信義區測試路 1 號 5 樓',
      ct: 'U2FsdGVkX1+3gtGbwPfk4tSSXFjBLKp3nWOuyb3xSjL34uGwhkL5z1tgocsRBc+V+6XNn33LVKk0zGxuw3ZHnw==' },
    { key: PASS_KEY, plain: '高雄市苓雅區測試街 22 號',
      ct: 'U2FsdGVkX1+eHFXd3Q+0R+b1mKfPWg2TLu8om/ogxG9Z/GuHDs+Iq/YkIGXVxZG9q1xHaBAw3pbrg5PwoT+Fcw==' },
    { key: PASS_KEY, plain: 'mywallet-key-check-v1',
      ct: 'U2FsdGVkX19clBaB4fM7SUQsNGm3+MYUTJ3QKlx3YDxsgiXebt1OuDUe3Rw8FH8c' },
    { key: PASS_KEY, plain: '12/28',
      ct: 'U2FsdGVkX1806iIQ/yzr5Wq7GYENNWQiM2jqltPe+VA=' },
];

GOLDEN.forEach(({ key, plain, ct }, i) => {
    let got;
    try { got = cryptoJsDecrypt(ct, key); }
    catch (e) { got = `拋出例外：${e.message}`; }
    expect(`黃金樣本 ${i + 1} 解得開且內容相同`, got, plain);
});

// canary 的明文必須等於原始碼裡那個常數 —— 兩邊對不上，所有人的密碼驗證都會失敗
expect('canary 密文解出的內容與原始碼常數一致',
    cryptoJsDecrypt(GOLDEN[2].ct, PASS_KEY),
    grab(/const KEY_CHECK_PLAINTEXT = '([^']+)'/, 'KEY_CHECK_PLAINTEXT'));

// 錯的金鑰必須解不開（而不是悄悄解出空字串後被當成成功）
let wrongKeyRejected = false;
try { cryptoJsDecrypt(GOLDEN[0].ct, PASS_KEY); } catch (e) { wrongKeyRejected = true; }
if (wrongKeyRejected) console.log('✅ 錯誤金鑰無法解開黃金樣本');
else { failures++; console.log('❌ 錯誤金鑰竟然解開了黃金樣本'); }

console.log(failures ? `\n❌ ${failures} 項不一致` : '\n全部通過：金鑰參數未被更動，既有密文仍解得開');
if (typeof process !== 'undefined' && process.exit) process.exit(failures ? 1 : 0);
