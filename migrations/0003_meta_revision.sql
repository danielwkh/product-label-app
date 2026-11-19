-- 0003_meta_revision.sql — 只新增資料表與索引，不會改動既有 products / labels
-- 套用方式：wrangler d1 execute product_labels --remote --file=migrations/0003_meta_revision.sql
-- （或用指令：node tools/deploy.mjs db）
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('products_revision', '1', datetime('now'));
INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('labels_revision', '1', datetime('now'));

-- 把目前資料的狀態記成「已存在的版本」，避免升級後第一次開啟頁面重覆建立
UPDATE meta SET value = CAST(strftime('%s','now') AS TEXT)
 WHERE key = 'products_revision' AND value = '1' AND (SELECT COUNT(*) FROM products) > 0;
UPDATE meta SET value = CAST(strftime('%s','now') AS TEXT)
 WHERE key = 'labels_revision' AND value = '1' AND (SELECT COUNT(*) FROM labels) > 0;
