# `.well-known/assetlinks.json`

給 **TWA（Trusted Web Activity）** 用的驗證檔：把 PWA 包成 Android APK 時，
Chrome 會來讀它確認「這個 APK 真的屬於這個網域」，通過才會拿掉畫面頂端的網址列。

---

## ⚠️ 這裡的檔案**不是** Chrome 會去讀的位置

Digital Asset Links 規格要求檔案必須在**網域根層**：

```
https://chianghf99.github.io/.well-known/assetlinks.json     ← Chrome 只看這裡
https://chianghf99.github.io/my-wallet/.well-known/...       ← 放在這裡沒有用
```

本專案是 GitHub Pages 的**專案頁面**，網址帶 `/my-wallet/` 子路徑，
所以根層不屬於這個 repo。實測（2026-10-31）：

```
https://chianghf99.github.io/                            → 404
https://chianghf99.github.io/.well-known/assetlinks.json → 404
repo chianghf99/chianghf99.github.io                     → 不存在
```

**要做 TWA 必須先開一個名為 `chianghf99.github.io` 的新 repo**（使用者頁面），
把 assetlinks 放在它的根目錄。那個 repo 只放這一個檔案也可以。

這個目錄下的 `assetlinks.json` 目前是空陣列 `[]`，作用只有兩個：
佔位，以及驗證 `.nojekyll` 確實讓點開頭的目錄發佈得出去。

---

## 為什麼旁邊有 `.nojekyll`

GitHub Pages 預設用 Jekyll 處理網站，而 **Jekyll 會忽略所有點開頭的目錄** ——
沒有 `.nojekyll` 的話 `.well-known/` 根本不會被發佈，一律 404。
本專案是純靜態 HTML，不需要 Jekyll 的任何功能，關掉沒有副作用。

**不要刪除 `.nojekyll`。** 新開的 `chianghf99.github.io` repo 也要放一份。

---

## 真的要做 APK 時的完整步驟

1. 在 GitHub 新建 repo，名稱**必須**是 `chianghf99.github.io`，設為 public，
   並在 Settings → Pages 啟用（Source 選 `main` 分支根目錄）。
2. 該 repo 根目錄放兩個檔：`.nojekyll`（空檔）與 `.well-known/assetlinks.json`。
3. 到 https://www.pwabuilder.com 貼上
   `https://chianghf99.github.io/my-wallet/mystock.html`，
   選 **Android → Generate Package**，下載 zip。
4. zip 裡附有產好的 `assetlinks.json`，放進步驟 2 的位置；
   或照下面格式自己填（包名與指紋都在 PWABuilder 頁面上）：

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "io.github.chianghf99.mywallet",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:…（簽章憑證的 SHA-256 指紋，冒號分隔、全大寫）"
      ]
    }
  }
]
```

5. push 後等 Pages 部署（約 1～2 分鐘），確認讀得到：

```bash
curl -s https://chianghf99.github.io/.well-known/assetlinks.json
```

6. 用 Google 的工具複驗：

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://chianghf99.github.io&relation=delegate_permission/common.handle_all_urls
```

---

## 注意事項

- **簽章金鑰務必備份。** 弄丟就無法更新同一個 APK，只能換包名重裝。
- 指紋填錯不會有錯誤訊息，症狀跟 404 一樣（APK 頂著一條網址列），很難查。
- 根層的 assetlinks 是**整個網域**共用的，`Radiology_Hub` 也在同一個網域下；
  這對個人使用沒有問題，只是要知道授權範圍不限於 `/my-wallet/`。
- **不要用 Cordova／Capacitor 這類 WebView 包裝。** 本專案用
  `signInWithPopup` 做 Google 登入，Google 會擋掉嵌入式 WebView
  （`disallowed_useragent`），會直接登不進去。TWA 跑的是 Chrome 本體，不受影響。
