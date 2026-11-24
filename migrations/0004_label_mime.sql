-- 0004_label_mime.sql — 只新增欄位，不會改動既有資料
-- 讓標籤可以保存 PDF 以外的檔案（例如 WePrint 用的 .wdfx），並記住正確的 Content-Type
-- 套用方式：node tools/deploy.mjs db 或 wrangler d1 execute product_labels --remote --file=migrations/0004_label_mime.sql
ALTER TABLE labels ADD COLUMN mime TEXT DEFAULT 'application/pdf';
UPDATE labels SET mime = 'application/pdf' WHERE mime IS NULL;
