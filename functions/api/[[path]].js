/*
 * Cloudflare Pages Functions — 商品標籤助手 API
 *
 * 與舊版的主要差異（資料不會被刪除）：
 *
 * 1. POST /api/products/bulk 預設為「合併」。舊版每批第一次呼叫都帶 replace=true，
 *    伺服器端會先 DELETE FROM products 再寫入；只要前端拿到的商品清單是空的或
 *    只有部分（例如 Excel 只匯入一小部分），整個雲端商品表就會被清空。
 *    現在必須明確傳 { mode: "replace", confirm: "REPLACE_ALL" } 才會清空。
 *
 * 2. 新增 content_hash / size 欄位：同一份 PDF 重複上傳時直接沿用，
 *    不重寫 R2 物件，也不會在 labels 表產生重複列。
 *
 * 3. 新增 POST /api/labels/sync：批次更新配對結果。
 *    舊版前端要為 174 個標籤逐一 PATCH，慢又容易中途失敗。
 *
 * 4. /api/labels/:id/file 支援 HTTP Range，PDF.js 在手機上載入大檔更穩定。
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function now() {
  return new Date().toISOString();
}

function segments(url) {
  return url.pathname.split('/').filter(Boolean);
}

function labelIdFromPath(url) {
  const parts = segments(url);
  const index = parts.indexOf('labels');
  return index >= 0 ? parts[index + 1] || null : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

const D1_BATCH_SIZE = 50;

let schemaReady = false;

/**
 * 只做「新增欄位 / 新增索引」的自動遷移，不會刪除或改寫任何既有資料。
 * 這樣就算忘記先跑 migrations，部署後第一次請求也會自動補上欄位。
 */
async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  try {
    const info = await env.DB.prepare("PRAGMA table_info('labels')").all();
    const columns = new Set((info.results || []).map(row => row.name));
    if (!columns.has('content_hash')) {
      await env.DB.prepare('ALTER TABLE labels ADD COLUMN content_hash TEXT').run();
    }
    if (!columns.has('size')) {
      await env.DB.prepare('ALTER TABLE labels ADD COLUMN size INTEGER DEFAULT 0').run();
    }
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_labels_content_hash ON labels(content_hash)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_labels_uploaded ON labels(uploaded_at)').run();
    schemaReady = true;
  } catch (err) {
    console.warn('ensureSchema failed', err && err.message);
  }
}

/* --------------------------------------------------------------- GET */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.pathname.endsWith('/api/health')) {
    const out = { ok: true, d1: Boolean(env.DB), r2: Boolean(env.LABELS), time: now() };
    if (env.DB) {
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS products FROM products').first();
        const labels = await env.DB.prepare('SELECT COUNT(*) AS labels FROM labels').first();
        out.products = row ? row.products : 0;
        out.labels = labels ? labels.labels : 0;
      } catch (err) {
        out.ok = false;
        out.error = String(err.message || err);
      }
    }
    return json(out, out.ok ? 200 : 500);
  }

  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);

  if (url.pathname.endsWith('/api/bootstrap')) {
    await ensureSchema(env);
    const products = await env.DB.prepare(
      'SELECT id, name, barcode, barcode2, label_id AS labelId, updated_at AS updatedAt FROM products ORDER BY id'
    ).all();
    const labels = await env.DB.prepare(`SELECT id, filename, name_from_file AS nameFromFile, product_id AS productId,
        matched_product_name AS matchedProductName, match_source AS matchSource, match_score AS matchScore,
        match_confidence AS matchConfidence, match_gap AS matchGap, match_why AS matchWhy,
        content_hash AS hash, size, uploaded_at AS uploadedAt, updated_at AS updatedAt
      FROM labels ORDER BY uploaded_at`).all();
    return json({
      products: products.results || [],
      labels: labels.results || [],
      cloud: true,
      version: 2
    });
  }

  if (url.pathname.includes('/api/labels/') && url.pathname.endsWith('/file')) {
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const id = labelIdFromPath(url);
    if (!id) return json({ error: 'Label id is required' }, 400);
    const row = await env.DB.prepare('SELECT r2_key, filename FROM labels WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Label not found' }, 404);

    const rangeHeader = request.headers.get('range');
    const headers = new Headers();
    headers.set('content-type', 'application/pdf');
    headers.set('accept-ranges', 'bytes');
    headers.set('content-disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    headers.set('cache-control', 'private, max-age=3600');

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const endRaw = match[2] ? Number(match[2]) : null;
        const object = await env.LABELS.get(row.r2_key, { range: endRaw == null ? { offset: start } : { offset: start, length: endRaw - start + 1 } });
        if (!object) return json({ error: 'PDF object not found' }, 404);
        const total = object.size;
        const offset = object.range ? object.range.offset || 0 : start;
        const length = object.range && object.range.length != null ? object.range.length : Math.max(0, total - offset);
        headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${total}`);
        headers.set('content-length', String(length));
        return new Response(object.body, { status: 206, headers });
      }
    }

    const object = await env.LABELS.get(row.r2_key);
    if (!object) return json({ error: 'PDF object not found' }, 404);
    const metadata = object.httpMetadata || {};
    headers.set('content-type', metadata.contentType || 'application/pdf');
    headers.set('content-length', String(object.size));
    if (object.httpEtag) headers.set('etag', object.httpEtag);
    return new Response(object.body, { headers });
  }

  return json({ error: 'Not found' }, 404);
}

/* --------------------------------------------------------------- POST */

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);

  /* 商品：合併（預設）或明確要求才整表取代 */
  if (url.pathname.endsWith('/api/products/bulk')) {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.products)) return json({ error: 'products array is required' }, 400);
    const replace = body.mode === 'replace' && body.confirm === 'REPLACE_ALL';
    const rows = body.products.filter(p => p && p.name);
    const timestamp = now();
    let written = 0;

    if (replace) {
      await env.DB.prepare('DELETE FROM products').run();
    }

    for (const group of chunk(rows, D1_BATCH_SIZE)) {
      const statements = group.map(p => env.DB.prepare(`INSERT INTO products (id, name, barcode, barcode2, label_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, barcode=excluded.barcode, barcode2=excluded.barcode2,
          label_id=COALESCE(excluded.label_id, products.label_id), updated_at=excluded.updated_at`).bind(
        Number(p.id), String(p.name), String(p.barcode || ''), String(p.barcode2 || ''),
        p.labelId || null, timestamp
      ));
      await env.DB.batch(statements);
      written += statements.length;
    }
    return json({ ok: true, count: written, mode: replace ? 'replace' : 'merge' });
  }

  /* 批次更新配對結果 */
  if (url.pathname.endsWith('/api/labels/sync')) {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.labels)) return json({ error: 'labels array is required' }, 400);
    const rows = body.labels.slice(0, 300);
    const timestamp = now();
    let written = 0;

    for (const group of chunk(rows, D1_BATCH_SIZE)) {
      const statements = [];
      for (const l of group) {
        if (!l || !l.id) continue;
        statements.push(env.DB.prepare(`UPDATE labels SET product_id=?, matched_product_name=?, match_source=?,
          match_score=?, match_confidence=?, match_gap=?, match_why=?, updated_at=? WHERE id=?`).bind(
          l.productId == null ? null : Number(l.productId),
          l.matchedProductName || null,
          l.matchSource || null,
          l.matchScore == null ? null : Number(l.matchScore),
          l.matchConfidence || null,
          l.matchGap == null ? null : Number(l.matchGap),
          l.matchWhy || null,
          timestamp,
          String(l.id)
        ));
      }
      if (statements.length) {
        await env.DB.batch(statements);
        written += statements.length;
      }
    }

    // 商品 label_id 以「這批有配對的標籤」為準重算，不動其他商品
    const linked = rows.filter(l => l && l.id && l.productId != null);
    for (const group of chunk(linked, D1_BATCH_SIZE)) {
      const statements = group.map(l => env.DB.prepare(
        'UPDATE products SET label_id = ?, updated_at = ? WHERE id = ?'
      ).bind(String(l.id), timestamp, Number(l.productId)));
      if (statements.length) await env.DB.batch(statements);
    }
    const unlinked = rows.filter(l => l && l.id && l.productId == null);
    for (const group of chunk(unlinked, D1_BATCH_SIZE)) {
      const statements = group.map(l => env.DB.prepare(
        'UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?'
      ).bind(timestamp, String(l.id)));
      if (statements.length) await env.DB.batch(statements);
    }

    return json({ ok: true, count: written });
  }

  /* 上傳 PDF（multipart） */
  if (url.pathname.endsWith('/api/labels')) {
    await ensureSchema(env);
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const form = await request.formData();
    const file = form.get('file');
    const id = String(form.get('id') || '');
    if (!(file instanceof File) || !id) return json({ error: 'id and PDF file are required' }, 400);

    const hash = String(form.get('hash') || '');
    const size = Number(form.get('size') || file.size || 0);
    const key = `labels/${id}.pdf`;

    // 同一個 id（= 內容 + 檔名 hash）且 R2 已有物件 → 不重寫
    const existing = await env.DB.prepare('SELECT id, content_hash, r2_key FROM labels WHERE id = ?').bind(id).first();
    let deduped = false;
    if (existing && existing.r2_key) {
      const head = await env.LABELS.head(existing.r2_key);
      if (head && (!hash || !existing.content_hash || existing.content_hash === hash)) {
        deduped = true;
      }
    }

    if (!deduped) {
      // 直接傳 File（Blob）給 R2：表單解析後已有實際長度，
      // 比 file.stream() 更可靠（串流沒有固定長度時 R2 會拒絕）。
      await env.LABELS.put(key, file, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { hash: hash || '', filename: String(form.get('filename') || file.name) }
      });
    }

    const timestamp = now();
    const uploadedAt = String(form.get('uploadedAt') || timestamp);
    await env.DB.prepare(`INSERT INTO labels (id, filename, name_from_file, product_id, matched_product_name, match_source,
        match_score, match_confidence, match_gap, match_why, r2_key, content_hash, size, uploaded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, name_from_file=excluded.name_from_file,
        product_id=excluded.product_id, matched_product_name=excluded.matched_product_name, match_source=excluded.match_source,
        match_score=excluded.match_score, match_confidence=excluded.match_confidence, match_gap=excluded.match_gap,
        match_why=excluded.match_why, r2_key=excluded.r2_key, content_hash=excluded.content_hash,
        size=excluded.size, updated_at=excluded.updated_at`).bind(
      id,
      String(form.get('filename') || file.name),
      String(form.get('nameFromFile') || file.name),
      form.get('productId') ? Number(form.get('productId')) : null,
      form.get('matchedProductName') || null,
      form.get('matchSource') || null,
      form.get('matchScore') ? Number(form.get('matchScore')) : null,
      form.get('matchConfidence') || null,
      form.get('matchGap') ? Number(form.get('matchGap')) : null,
      form.get('matchWhy') || null,
      key,
      hash || null,
      size,
      uploadedAt,
      timestamp
    ).run();

    const productId = form.get('productId');
    if (productId) {
      await env.DB.prepare('UPDATE products SET label_id = ?, updated_at = ? WHERE id = ?')
        .bind(id, timestamp, Number(productId)).run();
    }

    return json({ ok: true, id, deduped });
  }

  return json({ error: 'Not found' }, 404);
}

/* --------------------------------------------------------------- PATCH */

export async function onRequestPatch({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);
  if (!url.pathname.includes('/api/labels/')) return json({ error: 'Not found' }, 404);
  const id = labelIdFromPath(url);
  if (!id) return json({ error: 'Label id is required' }, 400);

  const body = await readJson(request);
  if (!body) return json({ error: 'JSON body is required' }, 400);
  const timestamp = now();

  await env.DB.prepare(`UPDATE labels SET product_id=?, matched_product_name=?, match_source=?, match_score=?,
      match_confidence=?, match_gap=?, match_why=?, updated_at=? WHERE id=?`).bind(
    body.productId == null ? null : Number(body.productId),
    body.matchedProductName || null,
    body.matchSource || null,
    body.matchScore == null ? null : Number(body.matchScore),
    body.matchConfidence || null,
    body.matchGap == null ? null : Number(body.matchGap),
    body.matchWhy || null,
    timestamp,
    id
  ).run();

  await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?').bind(timestamp, id).run();
  if (body.productId != null) {
    await env.DB.prepare('UPDATE products SET label_id = ?, updated_at = ? WHERE id = ?')
      .bind(id, timestamp, Number(body.productId)).run();
  }
  return json({ ok: true, id });
}

/* --------------------------------------------------------------- DELETE */

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);
  if (!url.pathname.includes('/api/labels/')) return json({ error: 'Not found' }, 404);
  const id = labelIdFromPath(url);
  if (!id) return json({ error: 'Label id is required' }, 400);

  const row = await env.DB.prepare('SELECT r2_key FROM labels WHERE id = ?').bind(id).first();
  if (env.LABELS && row && row.r2_key) await env.LABELS.delete(row.r2_key);
  await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?').bind(now(), id).run();
  await env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(id).run();
  return json({ ok: true, id });
}
