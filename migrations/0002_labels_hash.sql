-- 既有資料庫升級：只新增欄位與索引，不會刪除或修改任何既有資料 / PDF。
--
-- 套用方式：
--   npx wrangler d1 execute product-label-app --remote --file=./migrations/0002_labels_hash.sql
--
-- 若伺服器已經自動補上欄位（API 第一次請求時會自動檢查），
-- 這個檔案可能會回報 duplicate column name，可以忽略。

ALTER TABLE labels ADD COLUMN content_hash TEXT;
ALTER TABLE labels ADD COLUMN size INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_labels_content_hash ON labels(content_hash);
CREATE INDEX IF NOT EXISTS idx_labels_uploaded ON labels(uploaded_at);
