# vendor/

第三方函式庫**原封不動**放在這裡的那一份。

## 為什麼要自己放一份

原本是 `<script src="https://cdn.tailwindcss.com/3.4.17">` —— 而且是整個網站
**唯一一支沒有 `integrity` 的外部腳本**（其餘七支都有）。那代表：如果該 CDN 被入侵
或 DNS 被劫持，對方的 JavaScript 會跟我們自己的程式碼平起平坐 —— 讀得到已解密的
主金鑰、帳單、卡片地址，然後送往任何地方。

為什麼不是補一個 `integrity` 就好：

1. **SRI 很脆。** CDN 哪天動了那個檔，雜湊對不上就整支不執行 —— Tailwind 沒載到
   等於全站沒有 CSS，頁面直接變裸 HTML。自己放一份則完全不依賴對方。
2. `cdn.tailwindcss.com` 是 Tailwind 的 **Play CDN**，官方文件明講「僅供開發用」。
3. 順便補掉一個離線的洞：`sw.js` 的 `CDN_HOSTS` 沒有這個網域，所以它從來沒被快取過，
   離線時 PWA 其實是沒有樣式的。放進 `SHELL_ASSETS` 之後才真的能離線開。

## tailwind-3.4.17.js

- 來源：`https://cdn.tailwindcss.com/3.4.17`
- 取得日期：2026-11-12
- 大小：407,279 bytes
- `sha384-igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K`

**內容與 CDN 上的位元組完全相同，不要修改它**（下載前後共比對三次，三次一致）。
要驗證手上這份沒被動過：

```bash
openssl dgst -sha384 -binary vendor/tailwind-3.4.17.js | openssl base64 -A
```

升級版本時：換新檔案、改檔名裡的版號、更新上面的雜湊與日期，並同步修改
`mystock.html`、`mycreditcard.html` 的 `<script src>` 與 `sw.js` 的 `SHELL_ASSETS`＋`VERSION`。
