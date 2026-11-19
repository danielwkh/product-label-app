# 商品標籤助手 (Product Label Finder)

純前端 Web App，幫助你快速用條碼找到對應的營養標籤 PDF，並分享到 WePrint 列印。
支援一次匯入 **100 個以上**的 PDF：每個檔案獨立處理、可暫停／續傳／重試，失敗一個不會拖垮整批。

## 功能

- 上傳商品 Excel（主要使用「名稱」、「條碼」、「第二條碼」）
- 一次上傳多個營養標籤 PDF（可整個資料夾），**立即顯示總數與每個檔案的處理狀態**
- 自動配對：條碼（含尾 6 碼）＋ 檔名與商品名稱的多訊號比對（在 Web Worker 執行）
- 手動配對、解除配對、人工鎖定（人工結果不會被自動配對覆蓋）
- 手機相機掃描條碼 或 手動輸入尾 6 碼搜尋
- 找到後一鍵分享 PDF 到 WePrint App
- PDF.js 本地離線預覽（不依賴 CDN）
- 資料存瀏覽器（IndexedDB），可離線使用；雲端 D1 / R2 可讓同事共用
- 支援加入主畫面當成 PWA

## 大量 PDF 的處理方式

| 機制 | 說明 |
|---|---|
| 每檔狀態機 | `待處理 → 計算指紋 → 本機保存 → 配對中 → 已配對 → 上傳中 → 完成`，失敗／已存在另外標示 |
| 去重 | `id = 內容 hash + 檔名 hash`，同一份 PDF 只會存一次、只會上傳一次，重選同一批會全部標示「已存在（略過）」 |
| 本機／雲端分離 | 本機存檔與配對完成後才排入上傳佇列；本機階段不等網路 |
| 有限並行 | 上傳最多 2 條（可調），不用 `Promise.all` 一次射出上百個請求 |
| 容錯 | 每檔獨立 try/catch、IndexedDB transaction 有 timeout 與 `onabort`、上傳失敗自動退避重試 |
| 暫停／繼續／重試失敗 | 進度卡片上的按鈕；已完成的檔案不會重做 |
| 空間不足 | 自動改用「雲端優先」：PDF 直接上傳 R2，本機只保留 metadata |
| 大量商品 | 配對使用索引（條碼尾 6 碼、字元 bigram、詞倒排），成本與商品數幾乎無關：**22,481 商品約 2.3ms/檔**（舊版每個檔案都要對全庫跑一次 Fuse，實測 1,220ms/檔） |

詳細診斷與測試數據見 [`REPORT.md`](./REPORT.md)。

## 檔案結構

```
index.html                 畫面與樣式
js/app.js                  主程式（事件、搜尋、預覽、分享、手動配對、Excel）
js/core/text.js            正規化與相似度
js/core/matcher.js         索引式配對核心（純函式）
js/core/match.worker.js    配對 Web Worker
js/core/hash.js            內容指紋 / 穩定 label id
js/core/queue.js           有限並行佇列
js/core/pipeline.js        匯入狀態機（本機 / 雲端階段分離）
js/store/db.js             IndexedDB v3（metadata 與 PDF Blob 分開存放）
js/store/api.js            Cloudflare API 客戶端
js/ui/jobs-view.js         進度 UI
sw-v6.js                   Service Worker（shell/JS 用 network-first）
functions/api/[[path]].js  Pages Functions API
schema.sql / migrations/   D1 schema 與升級腳本
vendor/                    PDF.js、SheetJS、html5-qrcode（本地）
tools/                     測試工具（不會部署）
```

## 本機開發

> ⚠️ 新版使用 ES modules（`js/` 目錄），**不能直接雙擊 `index.html`（file://）開啟**，必須透過 HTTP 提供；
> Cloudflare Pages / GitHub Pages 都直接可用。若只是本機測試，用下面任一方式啟動即可。

```bash
# 只跑靜態頁面（搜尋/預覽可用，API 會失敗）
python3 -m http.server 8080

# 連 Pages Functions + D1 + R2 一起跑（需要 Node 22 與 wrangler）
npx wrangler pages dev . --d1 DB=product-label-app --r2 LABELS
```

## 測試

```bash
cd tools
npm install
node stress-test.mjs        # 舊版重現（卡在 10/174）＋ 新版壓測 T1–T12
node ui-smoke.mjs           # JSDOM：DOM 綁定、174 檔匯入、搜尋、重複匯入
node api-integration.mjs    # Miniflare：真 SQLite + R2，17 項 API 檢查
```

三個測試都不會碰到正式資料（各自使用暫存的記憶體資料庫）。

## Cloudflare 共用資料部署

前置（只需做一次）：

1. Cloudflare Pages 連上這個 repository，**Build command 留空**、**Output directory 設為 `/`**。
2. 建立 D1 database `product-label-app`，Binding 名稱設為 `DB`。
3. 建立 R2 bucket `product-label-app-labels`，Binding 名稱設為 `LABELS`。
4. 套用 schema（新資料庫）：

```bash
npx wrangler d1 execute product-label-app --remote --file=./schema.sql
```

既有資料庫只需補欄位（只新增，不會刪除資料；API 也會自動補）：

```bash
npx wrangler d1 execute product-label-app --remote --file=./migrations/0002_labels_hash.sql
```

5. 檢查 `https://<你的網域>/api/health` 應回 `{"ok":true,"d1":true,"r2":true,...}`。

> `wrangler.toml` 內的 binding 名稱（`DB`、`LABELS`）、資料庫名稱與 bucket 名稱都與舊版相同，**不需要重建或搬移任何資料**。

### 資料安全

- 商品同步一律使用 **merge**（只新增／更新），不會 `DELETE FROM products`。
  只有明確送出 `{ "mode": "replace", "confirm": "REPLACE_ALL" }` 才會清空，前端不會這樣送。
- 同一個 PDF 重複上傳時伺服器會回 `deduped: true`，不會重寫 R2 物件，也不會新增 D1 資料列。
- 前端「清除所有本地資料」只清瀏覽器端，**不會**動到 D1 / R2。

## 部署到 GitHub Pages（僅前端）

將 repository 根目錄作為靜態網站根目錄即可，但沒有 Functions 就沒有雲端共用（只能用本機資料）。
相機與 Service Worker 需要 HTTPS；Cloudflare Pages 與 GitHub Pages 都符合。
瀏覽器的 IndexedDB 與 Service Worker 以網域為單位，換網域後需要重新上傳資料。
