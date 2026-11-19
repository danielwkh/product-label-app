/*
 * Pages Functions 整合測試：用 Miniflare 提供「真的」D1（SQLite）與 R2 模擬器，
 * 直接呼叫 functions/api/[[path]].js 的 handler。
 *
 * 驗證：
 *   1. schema.sql 可以在空資料庫建立成功
 *   2. 商品批次寫入不會刪除既有資料（含舊客户端 payload）
 *   3. PDF 上傳 → R2 + D1 都正確，重複上傳會去重
 *   4. /api/labels/:id/file 支援 Range（PDF.js 在手機上需要）
 *   5. /api/labels/sync 一次更新 174 筆配對
 *   6. DELETE 會同時清掉 R2 與 D1
 *
 * 執行：node tools/api-integration.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { makeCatalog, makePdfFiles } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const api = await import('../functions/api/[[path]].js');

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-11-19',
  d1Databases: ['DB'],
  r2Buckets: ['LABELS']
});

const db = await mf.getD1Database('DB');
const r2 = await mf.getR2Bucket('LABELS');
const env = { DB: db, LABELS: r2 };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const request = (path, init) => new Request(`https://product-label-app.pages.dev${path}`, init);
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/* 1. schema */
console.log('\n=== 1. 套用 schema.sql ===');
const schema = readFileSync(join(root, 'schema.sql'), 'utf8');
const statements = schema
  .split(';')
  .map(s => s.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);
for (const statement of statements) await db.prepare(statement).run();
const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
check('建立 products / labels 資料表', tables.results.map(t => t.name).includes('products') && tables.results.map(t => t.name).includes('labels'), tables.results.map(t => t.name).join(', '));

/* 2. 商品批次寫入 */
console.log('\n=== 2. 商品批次寫入 ===');
const catalog = makeCatalog(1200);
const payload = catalog.map(p => ({ id: p.id, name: p.name, barcode: p.barcode, barcode2: p.barcode2 }));

let response = await api.onRequestPost({ request: request('/api/products/bulk', json({ products: payload })), env });
let body = await response.json();
check('第一次寫入 1,200 個商品', body.count === 1200, JSON.stringify(body));

// 舊版前端會送 replace: true（伺服器端舊程式碼會 DELETE FROM products）
response = await api.onRequestPost({ request: request('/api/products/bulk', json({ products: payload.slice(0, 3), replace: true })), env });
body = await response.json();
let count = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
check('舊 payload (replace:true) 不會清空商品表', count.n === 1200, `目前 ${count.n} 筆，回應 ${JSON.stringify(body)}`);

// 只更新 3 筆（模擬 Excel 只匯入部分商品）
response = await api.onRequestPost({ request: request('/api/products/bulk', json({ products: payload.slice(0, 3).map(p => ({ ...p, name: `${p.name} 新版` })) })), env });
count = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
check('部分更新後商品總數不變', count.n === 1200, `目前 ${count.n} 筆`);

/* 3. 上傳 174 個 PDF */
console.log('\n=== 3. 上傳 174 個 PDF 到 R2 + D1 ===');
const files = makePdfFiles(catalog, 174, { seed: 1234, minSize: 40 * 1024, maxSize: 400 * 1024 });
const { contentHash, makeLabelId } = await import('../js/core/hash.js');

const uploadStart = performance.now();
const uploaded = [];
for (const file of files) {
  const hash = await contentHash(file);
  const id = makeLabelId(hash, file.name);
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('id', id);
  form.append('hash', hash);
  form.append('size', String(file.size));
  form.append('filename', file.name);
  form.append('nameFromFile', file.name.replace(/\.pdf$/i, ''));
  const res = await api.onRequestPost({ request: request('/api/labels', { method: 'POST', body: form }), env });
  const jsonBody = await res.json();
  if (!jsonBody.ok) throw new Error(`上傳失敗 ${JSON.stringify(jsonBody)}`);
  uploaded.push({ id, hash, size: file.size, name: file.name });
}
const uploadMs = performance.now() - uploadStart;
const labelCount = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
check('174 個 PDF 全部寫入 D1', labelCount.n === 174, `${labelCount.n} 筆，耗時 ${Math.round(uploadMs)}ms（平均 ${(uploadMs / 174).toFixed(1)}ms/檔）`);

const r2List = await r2.list({ prefix: 'labels/' });
check('R2 有 174 個物件', r2List.objects.length === 174, `${r2List.objects.length} 個`);

const head = await r2.head(`labels/${uploaded[0].id}.pdf`);
check('R2 物件大小與原檔一致', head.size === uploaded[0].size, `${head.size} vs ${uploaded[0].size}`);
check('R2 物件 metadata = application/pdf', head.httpMetadata.contentType === 'application/pdf', head.httpMetadata.contentType);

/* 4. 重複上傳去重 */
console.log('\n=== 4. 重複上傳同一個 PDF ===');
const dupFile = files[0];
const dupHash = await contentHash(dupFile);
const dupId = makeLabelId(dupHash, dupFile.name);
const dupForm = new FormData();
dupForm.append('file', dupFile, dupFile.name);
dupForm.append('id', dupId);
dupForm.append('hash', dupHash);
dupForm.append('filename', dupFile.name);
const dupRes = await api.onRequestPost({ request: request('/api/labels', { method: 'POST', body: dupForm }), env });
const dupBody = await dupRes.json();
const dupCount = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
check('重複上傳回報 deduped，資料列數不變', dupBody.deduped === true && dupCount.n === 174, JSON.stringify(dupBody));

/* 5. Range 下載 */
console.log('\n=== 5. PDF 下載（含 Range）===');
response = await api.onRequestGet({ request: request(`/api/labels/${encodeURIComponent(uploaded[0].id)}/file`), env });
const full = new Uint8Array(await response.arrayBuffer());
check('完整下載 200 + 正確大小', response.status === 200 && full.length === uploaded[0].size, `${response.status}, ${full.length} bytes`);

response = await api.onRequestGet({
  request: new Request(`https://product-label-app.pages.dev/api/labels/${encodeURIComponent(uploaded[0].id)}/file`, { headers: { range: 'bytes=0-1023' } }),
  env
});
const partial = new Uint8Array(await response.arrayBuffer());
check('Range 請求回 206 且只傳 1KB', response.status === 206 && partial.length === 1024, `${response.status}, ${partial.length} bytes, ${response.headers.get('content-range')}`);

/* 6. 批次同步配對 */
console.log('\n=== 6. 批次同步 174 筆配對 ===');
const matchRows = uploaded.map((item, index) => ({
  id: item.id,
  productId: catalog[index % catalog.length].id,
  matchedProductName: catalog[index % catalog.length].name,
  matchSource: 'auto',
  matchScore: 500,
  matchConfidence: 'high',
  matchGap: 200,
  matchWhy: '名稱完全相同'
}));
const syncStart = performance.now();
response = await api.onRequestPost({ request: request('/api/labels/sync', json({ labels: matchRows })), env });
const syncMs = performance.now() - syncStart;
const syncBody = await response.json();
const matchedRows = await db.prepare('SELECT COUNT(*) AS n FROM labels WHERE matched_product_name IS NOT NULL').first();
const linkedProducts = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE label_id IS NOT NULL').first();
check('一次請求更新 174 筆配對', syncBody.ok && matchedRows.n === 174, `${Math.round(syncMs)}ms`);
check('商品 label_id 同步連結', linkedProducts.n === 174, `${linkedProducts.n} 個商品有標籤`);

/* 7. bootstrap */
console.log('\n=== 7. 便宜的版本檢查（meta / labels / ETag）===');
response = await api.onRequestGet({ request: request('/api/meta'), env });
const meta = await response.json();
check('/api/meta 只回版本資訊（不含商品陣列）', (meta.cloud === true || meta.ok === true) && Boolean(meta.revision) && !('products' in meta), JSON.stringify(meta));
check('/api/meta 帶出 products/labels revision', Boolean(meta.productsRevision) && Boolean(meta.labelsRevision), `${meta.productsRevision}/${meta.labelsRevision}`);

const beforeRev = meta.productsRevision;

response = await api.onRequestGet({ request: request('/api/labels'), env });
const labelOnly = await response.json();
check('/api/labels 只回標籤、不含商品', Array.isArray(labelOnly.labels) && !('products' in labelOnly), `${labelOnly.labels.length} 標籤`);

console.log('\n=== 7b. bootstrap 的 ETag / 304 ===');
response = await api.onRequestGet({ request: request('/api/bootstrap'), env });
const etag = response.headers.get('etag');
const revHeader = response.headers.get('x-data-revision');
check('bootstrap 回 ETag 與 revision', Boolean(etag) && Boolean(revHeader), `${etag} rev=${revHeader}`);
response = await api.onRequestGet({
  request: new Request(`http://localhost/api/bootstrap`, { headers: { 'if-none-match': etag } }),
  env
});
check('相同 revision 帶 If-None-Match 回 304（不再讀商品表）', response.status === 304, `status=${response.status}`);

console.log('\n=== 7c. bootstrap ===');
response = await api.onRequestGet({ request: request('/api/bootstrap'), env });
const boot = await response.json();
check('bootstrap 回傳商品、標籤與 hash', boot.products.length === 1200 && boot.labels.length === 174 && Boolean(boot.labels[0].hash), `${boot.products.length} 商品 / ${boot.labels.length} 標籤`);

console.log('\n=== 7d. 寫入商品後 revision 會變 ===');
await api.onRequestPost({
  request: request('/api/products/bulk', json({ products: [{ id: 'rev-probe', name: '版本測試', barcode: 'R1' }] })),
  env
});
response = await api.onRequestGet({ request: request('/api/meta'), env });
const meta2 = await response.json();
check('寫入商品後 revision 會變', meta2.productsRevision !== beforeRev, `${beforeRev} → ${meta2.productsRevision}`);

/* 8. health */
response = await api.onRequestGet({ request: request('/api/health'), env });
const health = await response.json();
check('health 回報 D1/R2 狀態（且附 revision）', health.ok === true && health.r2 === true && Boolean(health.productsRevision), JSON.stringify(health));

/* 9. DELETE */
console.log('\n=== 9. 刪除單一標籤 ===');
const deleteId = uploaded[1].id;
response = await api.onRequestDelete({ request: request(`/api/labels/${encodeURIComponent(deleteId)}`, { method: 'DELETE' }), env });
const afterDelete = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
const r2After = await r2.list({ prefix: 'labels/' });
check('刪除後 D1 與 R2 都少一筆', afterDelete.n === 173 && r2After.objects.length === 173, `D1 ${afterDelete.n} / R2 ${r2After.objects.length}`);

/* 10. 未設定 binding 的友善錯誤 */
response = await api.onRequestGet({ request: request('/api/bootstrap'), env: {} });
check('缺少 DB binding 時回 503 與清楚訊息', response.status === 503, (await response.json()).error);

const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) console.log('失敗項目：', failed.map(f => f.name).join(' | '));

await mf.dispose();
process.exit(failed.length ? 1 : 0);
