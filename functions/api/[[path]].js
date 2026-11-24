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
let schemaError = null;

const isQuotaError = message => /exceeded|free tier|row read|daily|1101|quota/i.test(String(message || ''));

async function ensureMetaTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )`).run();
}

/** 讀取少數幾筆 meta 資料（每次只讀 1~3 列，避免全表掃描） */
async function readMeta(env, keys) {
  const placeholders = keys.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${placeholders})`).bind(...keys).all();
  const out = {};
  for (const row of rows.results || []) out[row.key] = row.value;
  return out;
}

/** 內容變動時把 revision 往上加，前端就能用「4 列讀取」判斷是否需要重抓 */
async function bumpRevision(env, key) {
  // 版本號只是「省讀取」的優化：即使寫不進去，資料本身仍然正確，
  // 不要因此讓商品/標籤的寫入失敗。
  try {
    const timestamp = now();
    await env.DB.prepare(`INSERT INTO meta (key, value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`)
      .bind(key, timestamp).run();
    return true;
  } catch (err) {
    schemaError = String((err && err.message) || err);
    console.warn('bumpRevision failed', key, schemaError);
    return false;
  }
}

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
    if (!columns.has('deferred')) {
      // 「稍後處理」：商品資料庫還沒有這個商品時，先把標籤壓到清單最後面
      await env.DB.prepare('ALTER TABLE labels ADD COLUMN deferred INTEGER DEFAULT 0').run();
    }
    if (!columns.has('mime')) {
      // 支援 PDF 以外的檔案（例如 WePrint 用的 .wdfx）：記錄真正的 Content-Type
      await env.DB.prepare("ALTER TABLE labels ADD COLUMN mime TEXT DEFAULT 'application/pdf'").run();
    }
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_labels_content_hash ON labels(content_hash)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_labels_uploaded ON labels(uploaded_at)').run();
    await ensureMetaTable(env);
    schemaReady = true;
    schemaError = null;
  } catch (err) {
    schemaError = String((err && err.message) || err);
    console.warn('ensureSchema failed', schemaError);
  }
}

/* --------------------------------------------------------------- GET */

export async function onRequestGet({ request, env, context }) {
  const url = new URL(request.url);

  if (url.pathname.endsWith('/api/health')) {
    // 注意：這裡刻意不用 COUNT(*)（會全表掃描，22,481 列的商品表每次要燒 22,481 次 row read）。
    // 只讀 revision 這種單列資料，成本固定。
    const out = { ok: true, d1: Boolean(env.DB), r2: Boolean(env.LABELS), time: now() };
    if (env.DB) {
      try {
        await ensureSchema(env);
        await ensureSchema(env);
        const meta = await readMeta(env, ['products_revision', 'labels_revision']);
        out.productsRevision = meta.products_revision || '0';
        out.labelsRevision = meta.labels_revision || '0';
        out.metaTable = Boolean(meta.products_revision);
      } catch (err) {
        // 分兩種情況：
        //   1) 只是 meta 表還沒建立（例如額度不足導致 DDL 失敗）→ 服務仍可用，bootstrap 照常
        //   2) D1 完全讀不到（額度用完 / 逾時）→ 要誠實回報 ok:false，避免又被誤判成「沒啟用」
        out.metaTable = false;
        out.schemaError = schemaError || String((err && err.message) || err);
        if (isQuotaError(out.schemaError)) {
          out.ok = false;
          out.error = out.schemaError;
        }
        console.warn('health: readMeta failed', out.schemaError);
      }
    }
    return json(out, out.ok ? 200 : 500);
  }

  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);

  /* 便宜版本檢查：只回 revision，前端據此決定是否要抓全量 bootstrap */
  if (url.pathname.endsWith('/api/meta')) {
    await ensureSchema(env);
    let meta = null;
    let degraded = false;
    try {
      meta = await readMeta(env, ['products_revision', 'labels_revision']);
    } catch (err) {
      degraded = true;
      schemaError = String((err && err.message) || err);
    }
    return new Response(JSON.stringify({
      cloud: true,
      degraded,
      schemaError: degraded ? schemaError : undefined,
      productsRevision: meta ? (meta.products_revision || '0') : null,
      labelsRevision: meta ? (meta.labels_revision || '0') : null,
      revision: meta ? `${meta.products_revision || '0'}.${meta.labels_revision || '0'}` : null
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-d1-rows-read': '2'
      }
    });
  }

  /* 只取標籤清單（通常只有幾十~幾百列，比整包商品便宜很多） */
  if (url.pathname.endsWith('/api/labels')) {
    const labels = await env.DB.prepare(`SELECT id, filename, name_from_file AS nameFromFile, product_id AS productId,
        matched_product_name AS matchedProductName, match_source AS matchSource, match_score AS matchScore,
        match_confidence AS matchConfidence, match_gap AS matchGap, match_why AS matchWhy,
        content_hash AS hash, size, mime, deferred, uploaded_at AS uploadedAt, updated_at AS updatedAt
      FROM labels ORDER BY uploaded_at`).all();
    return json({ labels: labels.results || [], cloud: true });
  }

  if (url.pathname.endsWith('/api/bootstrap')) {
    await ensureSchema(env);

    // 以 revision 當 ETag / 邊緣快取 key：
    //   同一個 revision 只會真的查一次 D1，其他請求由 Cloudflare 邊緣直接回應
    const requestedRevision = url.searchParams.get('rev');
    const ifNoneMatch = request.headers.get('if-none-match');
    const meta = await readMeta(env, ['products_revision', 'labels_revision']);
    const revisionParts = {
      products: String(meta.products_revision || '0'),
      labels: String(meta.labels_revision || '0')
    };
    let revision = requestedRevision || `${revisionParts.products}.${revisionParts.labels}`;
    const etag = `W/"bootstrap-${revision}"`;
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=60' } });
    }

    const edgeCache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
    const cacheKey = edgeCache ? new Request(`${url.origin}/api/bootstrap?rev=${encodeURIComponent(revision)}`, { method: 'GET' }) : null;
    if (edgeCache && cacheKey) {
      try {
        const hit = await edgeCache.match(cacheKey);
        if (hit) return hit;
      } catch { /* 快取不可用就照常查詢 */ }
    }

    const products = await env.DB.prepare(
      'SELECT id, name, barcode, barcode2, label_id AS labelId, updated_at AS updatedAt FROM products ORDER BY id'
    ).all();
    const labels = await env.DB.prepare(`SELECT id, filename, name_from_file AS nameFromFile, product_id AS productId,
        matched_product_name AS matchedProductName, match_source AS matchSource, match_score AS matchScore,
        match_confidence AS matchConfidence, match_gap AS matchGap, match_why AS matchWhy,
        content_hash AS hash, size, mime, deferred, uploaded_at AS uploadedAt, updated_at AS updatedAt
      FROM labels ORDER BY uploaded_at`).all();
    const payload = {
      products: products.results || [],
      labels: labels.results || [],
      cloud: true,
      version: 2,
      revision,
      productsRevision: revisionParts.products,
      labelsRevision: revisionParts.labels
    };
    const response = new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'x-data-revision': revision,
        etag
      }
    });
    if (edgeCache && cacheKey) {
      try {
        context.waitUntil(edgeCache.put(cacheKey, response.clone()));
      } catch { /* ignore */ }
    }
    return response;
  }

  if (url.pathname.includes('/api/labels/') && url.pathname.endsWith('/file')) {
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const id = labelIdFromPath(url);
    if (!id) return json({ error: 'Label id is required' }, 400);
    const row = await env.DB.prepare('SELECT r2_key, filename, mime FROM labels WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Label not found' }, 404);

    const storedMime = row.mime || 'application/pdf';
    const wantsDownload = url.searchParams.get('download') === '1';
    const rangeHeader = request.headers.get('range');
    const headers = new Headers();
    headers.set('content-type', storedMime);
    headers.set('accept-ranges', 'bytes');
    headers.set('content-disposition',
      `${wantsDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.filename || 'label')}`);
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

    await ensureSchema(env);
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
    if (written || replace) await bumpRevision(env, 'products_revision');
    return json({ ok: true, count: written, mode: replace ? 'replace' : 'merge' });
  }

  /* 刪除指定商品（Excel 增量匯入：只送「已從 Excel 移除」的那幾筆） */
  if (url.pathname.endsWith('/api/products/delete')) {
    await ensureSchema(env);
    const body = await readJson(request);
    const raw = body && Array.isArray(body.ids) ? body.ids : null;
    if (!raw) return json({ error: 'ids array is required' }, 400);
    const ids = raw.map(Number).filter(n => Number.isFinite(n));
    if (!ids.length) return json({ error: 'ids array is required' }, 400);
    if (ids.length > 300) return json({ error: 'too many ids in one request (max 300)' }, 400);

    const timestamp = now();
    let deletedProducts = 0;
    let unlinkedLabels = 0;
    for (const group of chunk(ids, 100)) {
      const placeholders = group.map(() => '?').join(',');
      const res = await env.DB.prepare(`DELETE FROM products WHERE id IN (${placeholders})`).bind(...group).run();
      deletedProducts += (res.meta && res.meta.changes) || 0;
      const unlink = await env.DB.prepare(`UPDATE labels SET product_id=NULL, matched_product_name=NULL,
          match_source=NULL, match_score=NULL, match_confidence=NULL, match_gap=NULL, match_why=NULL, updated_at=?
        WHERE product_id IN (${placeholders})`).bind(timestamp, ...group).run();
      unlinkedLabels += (unlink.meta && unlink.meta.changes) || 0;
    }
    if (deletedProducts || unlinkedLabels) {
      await bumpRevision(env, 'products_revision');
    }
    if (unlinkedLabels) await bumpRevision(env, 'labels_revision');
    return json({ ok: true, deletedProducts, unlinkedLabels });
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
          match_score=?, match_confidence=?, match_gap=?, match_why=?,
          deferred=COALESCE(?, deferred), updated_at=? WHERE id=?`).bind(
          l.productId == null ? null : Number(l.productId),
          l.matchedProductName || null,
          l.matchSource || null,
          l.matchScore == null ? null : Number(l.matchScore),
          l.matchConfidence || null,
          l.matchGap == null ? null : Number(l.matchGap),
          l.matchWhy || null,
          l.deferred == null ? null : (l.deferred ? 1 : 0),
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

    if (written) await bumpRevision(env, 'labels_revision');
    if (linked.length || unlinked.length) await bumpRevision(env, 'products_revision');
    return json({ ok: true, count: written });
  }

  /* 上傳 PDF（multipart） */
  /* 清除雲端資料（危險操作：必須輸入「清除」才會執行） */
  if (url.pathname.endsWith('/api/cloud/clear')) {
    await ensureSchema(env);
    const body = await readJson(request);
    const scope = String((body && body.scope) || '');
    const confirmText = String((body && body.confirm) || '').trim();
    if (!['labels', 'products', 'all'].includes(scope)) {
      return json({ error: 'scope 必須是 labels / products / all' }, 400);
    }
    if (confirmText !== '清除') {
      return json({ error: '需要輸入「清除」兩個字才會執行' }, 400);
    }

    let deletedLabels = 0;
    let deletedObjects = 0;
    let deletedProducts = 0;

    if (scope === 'labels' || scope === 'all') {
      // 1) R2：先刪檔案（分批 list，避免一次拉太多）
      if (env.LABELS) {
        let cursor;
        do {
          const options = { prefix: 'labels/', limit: 1000 };
          if (cursor) options.cursor = cursor;
          const listed = await env.LABELS.list(options);
          const keys = (listed.objects || []).map(object => object.key);
          if (keys.length) {
            await env.LABELS.delete(keys);
            deletedObjects += keys.length;
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      }
      // 2) D1
      const labelCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM labels').first();
      deletedLabels = labelCount ? labelCount.n : 0;
      if (scope === 'labels') {
        await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ?').bind(now()).run();
      }
      await env.DB.prepare('DELETE FROM labels').run();
    }

    if (scope === 'products' || scope === 'all') {
      const productCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first();
      deletedProducts = productCount ? productCount.n : 0;
      await env.DB.prepare('DELETE FROM products').run();
    }

    await bumpRevision(env, 'labels_revision');
    await bumpRevision(env, 'products_revision');
    return json({ ok: true, scope, deletedLabels, deletedProducts, deletedObjects });
  }

  /* 批次刪除：重複標籤一次清掉，不用送幾十個 DELETE */
  if (url.pathname.endsWith('/api/labels/bulk-delete')) {
    await ensureSchema(env);
    const body = await readJson(request);
    const ids = Array.isArray(body && body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return json({ error: 'ids array is required' }, 400);
    if (ids.length > 300) return json({ error: '一次最多刪除 300 筆' }, 400);

    const rows = await env.DB.prepare(
      `SELECT id, r2_key AS r2Key FROM labels WHERE id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    const found = rows.results || [];
    if (env.LABELS) {
      for (const row of found) {
        if (row.r2Key) await env.LABELS.delete(row.r2Key).catch(() => {});
      }
    }
    const timestamp = now();
    const statements = [
      env.DB.prepare(`UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id IN (${ids.map(() => '?').join(',')})`)
        .bind(timestamp, ...ids),
      env.DB.prepare(`DELETE FROM labels WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
    ];
    await env.DB.batch(statements);
    await bumpRevision(env, 'labels_revision');
    await bumpRevision(env, 'products_revision');
    return json({ ok: true, deleted: found.length, ids: found.map(row => row.id) });
  }

  if (url.pathname.endsWith('/api/labels')) {
    await ensureSchema(env);
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const form = await request.formData();
    const file = form.get('file');
    const id = String(form.get('id') || '');
    if (!(file instanceof File) || !id) return json({ error: 'id and PDF file are required' }, 400);

    const hash = String(form.get('hash') || '');
    const size = Number(form.get('size') || file.size || 0);
    const originalName = String(form.get('filename') || file.name || '');
    const ext = String(form.get('ext') || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 8) || 'pdf';
    const mime = String(form.get('mime') || file.type || 'application/pdf').slice(0, 120);
    const key = `labels/${id}.${ext}`;

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
        httpMetadata: { contentType: mime },
        customMetadata: { hash: hash || '', filename: originalName, ext, mime }
      });
    }

    const timestamp = now();
    const uploadedAt = String(form.get('uploadedAt') || timestamp);
    await env.DB.prepare(`INSERT INTO labels (id, filename, name_from_file, product_id, matched_product_name, match_source,
        match_score, match_confidence, match_gap, match_why, r2_key, content_hash, size, mime, uploaded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, name_from_file=excluded.name_from_file,
        product_id=excluded.product_id, matched_product_name=excluded.matched_product_name, match_source=excluded.match_source,
        match_score=excluded.match_score, match_confidence=excluded.match_confidence, match_gap=excluded.match_gap,
        match_why=excluded.match_why, r2_key=excluded.r2_key, content_hash=excluded.content_hash,
        size=excluded.size, mime=excluded.mime, updated_at=excluded.updated_at`).bind(
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
      mime,
      uploadedAt,
      timestamp
    ).run();

    await bumpRevision(env, 'labels_revision');
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

  const existing = await env.DB.prepare('SELECT * FROM labels WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Label not found', id }, 404);

  // 部分更新：只改 body 有帶的欄位，其他保持原值
  // （舊版一律覆寫，前端只傳 nameFromFile 時會把配對資料清空）
  const pick = (key, current) => (Object.prototype.hasOwnProperty.call(body, key) ? body[key] : current);
  const numberOrNull = value => (value == null || value === '' ? null : Number(value));
  const timestamp = now();

  const nameFromFile = pick('nameFromFile', existing.name_from_file);
  const productId = numberOrNull(pick('productId', existing.product_id));
  const matchedProductName = pick('matchedProductName', existing.matched_product_name);
  const matchSource = pick('matchSource', existing.match_source);
  const matchScore = numberOrNull(pick('matchScore', existing.match_score));
  const matchConfidence = pick('matchConfidence', existing.match_confidence);
  const matchGap = numberOrNull(pick('matchGap', existing.match_gap));
  const matchWhy = pick('matchWhy', existing.match_why);
  const deferred = Object.prototype.hasOwnProperty.call(body, 'deferred')
    ? (body.deferred ? 1 : 0)
    : (existing.deferred ? 1 : 0);

  await env.DB.prepare(`UPDATE labels SET name_from_file=?, product_id=?, matched_product_name=?, match_source=?,
      match_score=?, match_confidence=?, match_gap=?, match_why=?, deferred=?, updated_at=? WHERE id=?`).bind(
    nameFromFile == null ? null : String(nameFromFile).slice(0, 300),
    productId == null || Number.isNaN(productId) ? null : productId,
    matchedProductName || null,
    matchSource || null,
    matchScore == null || Number.isNaN(matchScore) ? null : matchScore,
    matchConfidence || null,
    matchGap == null || Number.isNaN(matchGap) ? null : matchGap,
    matchWhy || null,
    deferred,
    timestamp,
    id
  ).run();

  // 配對有變動才去改 products.label_id（省寫入）
  const productChanged = productId !== (existing.product_id == null ? null : Number(existing.product_id));
  if (productChanged) {
    await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?').bind(timestamp, id).run();
    if (productId != null) {
      await env.DB.prepare('UPDATE products SET label_id = ?, updated_at = ? WHERE id = ?')
        .bind(id, timestamp, productId).run();
    }
    await bumpRevision(env, 'products_revision');
  }
  await bumpRevision(env, 'labels_revision');
  return json({ ok: true, id, nameFromFile });
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
  await bumpRevision(env, 'labels_revision');
  await bumpRevision(env, 'products_revision');
  return json({ ok: true, id });
}
