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

## 部署到 GitHub Pages

1. 到 Settings → Pages → Source 選 main branch / root
2. 之後就能用 `https://danielwkh.github.io/product-label-app/` 開啟

## 注意

- iOS Safari 分享檔案需要較新版本系統
- 相機權限需要 HTTPS 或 localhost
- 建議用 Chrome 或 Safari 開啟
