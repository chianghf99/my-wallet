// 公開日誌的最後一道防線。
//
// 這個 repo 是 public，GitHub Actions 的執行日誌不需登入就看得到。
// snapshot.mjs 與 bill-reminder.mjs 的檔頭都寫了「只能印筆數與狀態，不可印 uid」，
// 但那條規則整支程式都靠呼叫端自律遵守 —— 每個 console.log 都是人工挑過的。
// 唯一的例外是最底下的 catch：它把錯誤丟給 console.error，而錯誤訊息是
// firebase-admin 給的，不是我們寫的。它會帶文件路徑，路徑裡有 uid：
//
//   5 NOT_FOUND: no entity to update: app: "s~…" path < Element { type: "users" name: "<uid>" } >
//   Document not found: projects/…/databases/(default)/documents/users/<uid>/creditcard/data
//
// 平常不會觸發，壞掉的那天才會 —— 所以沒有人會注意到它漏了什麼。
//
// 為什麼不能只依賴 GitHub 的 secret 遮蔽：它比對的是「完整的 secret 字串」。
//   1. APP_UID 允許多組以逗號分隔。存的是 "uid1,uid2" 時，日誌裡只出現 uid1
//      並不等於出現了那個 secret，不會被遮。
//   2. SNAPSHOT_ALL_USERS 模式下的 uid 是 listDocuments() 讀來的（別人的帳號），
//      從頭到尾都不是 secret，永遠不會被遮。
// 遮蔽是第二層，這裡才是第一層。

// 以路徑為準（uid 長度不一定是 28）＋ 以長度為準（沒有路徑前綴的 gRPC 格式）兩條都要。
const RULES = [
    [/((?:documents\/)?users\/)[A-Za-z0-9_-]{6,}/g, '$1<uid>'],
    [/\b[A-Za-z0-9]{28}\b/g, '<uid>'],
];

/**
 * 把錯誤整理成可以安全印進公開日誌的字串。
 * 傳整個 Error 進來即可（會取 stack，保留行號方便查問題）。
 */
export const redactLog = (value) => {
    const text = String((value && value.stack) || value);
    return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
};
