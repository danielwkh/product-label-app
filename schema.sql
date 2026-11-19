-- 商品標籤助手 — D1 schema（全新安裝用；既有資料庫請執行 migrations/0002_labels_hash.sql）
--
-- 套用方式：
--   npx wrangler d1 execute product-label-app --remote --file=./schema.sql
--
-- 注意：本檔案只包含 CREATE ... IF NOT EXISTS，不會刪除任何既有資料。

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  barcode2 TEXT DEFAULT '',
  label_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  name_from_file TEXT NOT NULL,
  product_id INTEGER,
  matched_product_name TEXT,
  match_source TEXT,
  match_score INTEGER,
  match_confidence TEXT,
  match_gap INTEGER,
  match_why TEXT,
  r2_key TEXT NOT NULL,
  content_hash TEXT,          -- PDF 內容指紋（重複上傳時用來去重）
  size INTEGER DEFAULT 0,     -- PDF 位元組數
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_barcode2 ON products(barcode2);
CREATE INDEX IF NOT EXISTS idx_labels_product_id ON labels(product_id);
CREATE INDEX IF NOT EXISTS idx_labels_content_hash ON labels(content_hash);
CREATE INDEX IF NOT EXISTS idx_labels_uploaded ON labels(uploaded_at);

-- ---------------------------------------------------------------------------
-- meta：資料版本號（用來避免每次開頁都整表讀取商品，省 D1 row read 額度）
-- API 也會在需要時自動建立（ensureMetaTable），這裡只是讓全新資料庫一次到位。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('products_revision', '1', datetime('now'));
INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('labels_revision', '1', datetime('now'));
