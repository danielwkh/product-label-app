-- 0005_label_deferred.sql — 只新增欄位，不會改動既有資料
-- 「稍後處理」：商品資料庫還沒有這個商品時，把標籤壓到配對清單最後面
-- 套用方式：node tools/deploy.mjs db 或 wrangler d1 execute product_labels --remote --file=migrations/0005_label_deferred.sql
ALTER TABLE labels ADD COLUMN deferred INTEGER DEFAULT 0;
UPDATE labels SET deferred = 0 WHERE deferred IS NULL;
