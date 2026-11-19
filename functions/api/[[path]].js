function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function now() { return new Date().toISOString(); }
function getId(url, prefix) {
  const value = url.pathname.split('/').filter(Boolean);
  const index = value.indexOf(prefix);
  return index >= 0 ? value[index + 1] : null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);

  if (url.pathname.endsWith('/api/bootstrap')) {
    const products = await env.DB.prepare('SELECT id, name, barcode, barcode2, label_id AS labelId, updated_at AS updatedAt FROM products ORDER BY id').all();
    const labels = await env.DB.prepare(`SELECT id, filename, name_from_file AS nameFromFile, product_id AS productId,
      matched_product_name AS matchedProductName, match_source AS matchSource, match_score AS matchScore,
      match_confidence AS matchConfidence, match_gap AS matchGap, match_why AS matchWhy,
      uploaded_at AS uploadedAt, updated_at AS updatedAt FROM labels ORDER BY uploaded_at`).all();
    return json({ products: products.results || [], labels: labels.results || [], cloud: true });
  }

  if (url.pathname.includes('/api/labels/') && url.pathname.endsWith('/file')) {
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const id = getId(url, 'labels');
    const row = await env.DB.prepare('SELECT r2_key, filename FROM labels WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Label not found' }, 404);
    const object = await env.LABELS.get(row.r2_key);
    if (!object) return json({ error: 'PDF object not found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    headers.set('cache-control', 'private, max-age=3600');
    return new Response(object.body, { headers });
  }

  return json({ error: 'Not found' }, 404);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);

  if (url.pathname.endsWith('/api/products/bulk')) {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.products)) return json({ error: 'products array is required' }, 400);
    const statements = [];
    if (body.replace === true) statements.push(env.DB.prepare('DELETE FROM products'));
    statements.push(...body.products.filter(p => p && p.name).map(p => env.DB.prepare(`INSERT INTO products (id, name, barcode, barcode2, label_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, barcode=excluded.barcode, barcode2=excluded.barcode2,
      label_id=COALESCE(products.label_id, excluded.label_id), updated_at=excluded.updated_at`).bind(
        Number(p.id), String(p.name), String(p.barcode || ''), String(p.barcode2 || ''), p.labelId || null, now()
      )));
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true, count: statements.length });
  }

  if (url.pathname.endsWith('/api/labels')) {
    if (!env.LABELS) return json({ error: 'R2 binding LABELS is not configured' }, 503);
    const form = await request.formData();
    const file = form.get('file');
    const id = String(form.get('id') || '');
    if (!(file instanceof File) || !id) return json({ error: 'id and PDF file are required' }, 400);
    const key = `labels/${id}.pdf`;
    await env.LABELS.put(key, file.stream(), { httpMetadata: { contentType: 'application/pdf' } });
    const timestamp = now();
    await env.DB.prepare(`INSERT INTO labels (id, filename, name_from_file, product_id, matched_product_name, match_source,
      match_score, match_confidence, match_gap, match_why, r2_key, uploaded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, name_from_file=excluded.name_from_file,
      product_id=excluded.product_id, matched_product_name=excluded.matched_product_name, match_source=excluded.match_source,
      match_score=excluded.match_score, match_confidence=excluded.match_confidence, match_gap=excluded.match_gap,
      match_why=excluded.match_why, r2_key=excluded.r2_key, updated_at=excluded.updated_at`).bind(
        id, String(form.get('filename') || file.name), String(form.get('nameFromFile') || file.name),
        form.get('productId') ? Number(form.get('productId')) : null, form.get('matchedProductName') || null,
        form.get('matchSource') || null, form.get('matchScore') ? Number(form.get('matchScore')) : null,
        form.get('matchConfidence') || null, form.get('matchGap') ? Number(form.get('matchGap')) : null,
        form.get('matchWhy') || null, key, form.get('uploadedAt') || timestamp, timestamp
      ).run();
    return json({ ok: true, id });
  }

  return json({ error: 'Not found' }, 404);
}

export async function onRequestPatch({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);
  if (!url.pathname.includes('/api/labels/')) return json({ error: 'Not found' }, 404);
  const id = getId(url, 'labels');
  const body = await readJson(request);
  if (!body) return json({ error: 'JSON body is required' }, 400);
  const fields = {
    product_id: body.productId ?? null,
    matched_product_name: body.matchedProductName || null,
    match_source: body.matchSource || null,
    match_score: body.matchScore ?? null,
    match_confidence: body.matchConfidence || null,
    match_gap: body.matchGap ?? null,
    match_why: body.matchWhy || null
  };
  await env.DB.prepare(`UPDATE labels SET product_id=?, matched_product_name=?, match_source=?, match_score=?,
    match_confidence=?, match_gap=?, match_why=?, updated_at=? WHERE id=?`).bind(
      fields.product_id, fields.matched_product_name, fields.match_source, fields.match_score,
      fields.match_confidence, fields.match_gap, fields.match_why, now(), id
    ).run();
  await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?').bind(now(), id).run();
  if (fields.product_id) await env.DB.prepare('UPDATE products SET label_id = ?, updated_at = ? WHERE id = ?').bind(id, now(), fields.product_id).run();
  return json({ ok: true, id });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ error: 'D1 binding DB is not configured' }, 503);
  if (!url.pathname.includes('/api/labels/')) return json({ error: 'Not found' }, 404);
  const id = getId(url, 'labels');
  const row = await env.DB.prepare('SELECT r2_key FROM labels WHERE id = ?').bind(id).first();
  if (env.LABELS && row?.r2_key) await env.LABELS.delete(row.r2_key);
  await env.DB.prepare('UPDATE products SET label_id = NULL, updated_at = ? WHERE label_id = ?').bind(now(), id).run();
  await env.DB.prepare('DELETE FROM labels WHERE id = ?').bind(id).run();
  return json({ ok: true, id });
}
