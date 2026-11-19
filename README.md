# 商品標籤助手 (Product Label Finder)

純前端 Web App，幫助你快速用條碼找到對應的營養標籤 PDF，並分享到 WePrint 列印。

## 功能

- 上傳商品 Excel（主要使用「名稱」、「條碼」、「第二條碼」）
- 一次上傳多個營養標籤 PDF（檔名包含商品中文名稱）
- 自動模糊比對檔名與商品名稱
- 手機相機掃描條碼 或 手動輸入搜尋
- 找到後一鍵分享 PDF 到 WePrint App
- 資料存在瀏覽器本地（IndexedDB），可離線使用
- 支援加入主畫面當成 PWA

## 使用方法

1. 用手機瀏覽器打開 `index.html`（或部署後的網址）
2. 在「上傳資料」頁上傳 Excel 和 PDF
3. 切換到「搜尋 / 掃碼」頁，掃描或輸入條碼
4. 點「分享到 WePrint」→ 選擇 WePrint App

## 技術

- 純前端（HTML + JS）
- SheetJS 讀 Excel
- Fuse.js 模糊搜尋
- html5-qrcode 條碼掃描
- IndexedDB 本地儲存
- Web Share API 分享檔案
- PDF.js、SheetJS、Fuse.js、html5-qrcode 皆存放於 `vendor/`，PDF 預覽不依賴 CDN
- `sw.js` 會快取 App shell，完成首次線上載入後可離線啟動與預覽 PDF

## 部署到 Cloudflare Pages / GitHub Pages

將整個 repository 根目錄作為靜態網站根目錄，不需要 build command，也不需要後端。

部署後第一次請在網路正常時開啟網站，等待 Service Worker 安裝完成，再重新整理一次。之後 App shell、PDF.js 與其他前端相依檔會由 Service Worker 快取，離線時仍可開啟 App 和預覽已儲存在 IndexedDB 的 PDF。

相機功能及 Service Worker 都需要 HTTPS；Cloudflare Pages 和 GitHub Pages 均符合此條件。瀏覽器的 IndexedDB 和 Service Worker 是以網域為單位保存，換網域後需要重新上傳資料。

## 注意

- iOS Safari 分享檔案需要較新版本系統
- 相機權限需要 HTTPS 或 localhost
- 建議用 Chrome 或 Safari 開啟
