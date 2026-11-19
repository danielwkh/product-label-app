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
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_barcode2 ON products(barcode2);
CREATE INDEX IF NOT EXISTS idx_labels_product_id ON labels(product_id);
