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


/* ------------------------- 5b. 非 PDF 檔（.wdfx）不可以被當成 PDF 送出去 */
console.log('\n=== 5b. .wdfx 的類型與檔名 ===');
const wdfxBytes = new Uint8Array([0x57, 0x44, 0x46, 0x58, 0x00, 0x01, 0x02, 0x03]);
const wdfxForm = new FormData();
wdfxForm.append('file', new File([wdfxBytes], '測試標籤.wdfx', { type: 'application/pdf' }), '測試標籤.wdfx');
wdfxForm.append('id', 'wdfx-test-1');
wdfxForm.append('hash', 'hash-wdfx-1');
wdfxForm.append('filename', '測試標籤.wdfx');
wdfxForm.append('mime', 'application/pdf');          // 故意送錯：伺服器必須自己依副檔名修正
wdfxForm.append('ext', 'wdfx');
const wdfxRes = await api.onRequestPost({ request: request('/api/labels', { method: 'POST', body: wdfxForm }), env });
check('.wdfx 可以上傳', wdfxRes.status === 200, String(wdfxRes.status));

const wdfxRow = await db.prepare('SELECT mime, filename FROM labels WHERE id = ?').bind('wdfx-test-1').first();
check('資料表不會把它存成 application/pdf', wdfxRow.mime === 'application/octet-stream', wdfxRow.mime);

const wdfxHead = await r2.head('labels/wdfx-test-1.wdfx');
check('R2 的 Content-Type 也是 octet-stream', wdfxHead.httpMetadata.contentType === 'application/octet-stream',
  wdfxHead.httpMetadata.contentType);

const wdfxFile = await api.onRequestGet({ request: request('/api/labels/wdfx-test-1/file'), env });
check('下載時 content-type 不是 PDF', wdfxFile.headers.get('content-type') === 'application/octet-stream',
  wdfxFile.headers.get('content-type'));
const disposition = wdfxFile.headers.get('content-disposition') || '';
check('檔名保留 .wdfx 副檔名', /wdfx/i.test(decodeURIComponent(disposition)), disposition);
check('非 PDF 一律用 attachment（不會被瀏覽器當成 PDF 開啟）', /attachment/.test(disposition), disposition);

// 舊資料：mime 寫錯成 application/pdf，但檔名是 .wdfx → 仍要修正
await db.prepare("UPDATE labels SET mime = 'application/pdf' WHERE id = 'wdfx-test-1'").run();
const legacyFile = await api.onRequestGet({ request: request('/api/labels/wdfx-test-1/file'), env });
check('舊資料 mime 寫錯時，仍以副檔名為準', legacyFile.headers.get('content-type') === 'application/octet-stream',
  legacyFile.headers.get('content-type'));
await db.prepare("UPDATE labels SET mime = 'application/octet-stream' WHERE id = 'wdfx-test-1'").run();

// 清掉這個測試標籤，避免影響後面的數量統計
await api.onRequestDelete({ request: request('/api/labels/wdfx-test-1', { method: 'DELETE' }), env });
const wdfxGone = await db.prepare('SELECT COUNT(*) AS n FROM labels WHERE id = ?').bind('wdfx-test-1').first();
check('測試標籤已清除（不影響後續統計）', wdfxGone.n === 0, String(wdfxGone.n));

/* --------------- 5c. 一次性自動修正：舊資料的 mime（migrations/0006） --------------- */
console.log('\n=== 5c. 舊資料 mime 自動修正（只跑一次）===');
const staleSql = "SELECT COUNT(*) AS n FROM labels WHERE mime = 'application/pdf' AND lower(filename) NOT LIKE '%.pdf'";
// 模擬早期上傳：.wdfx 被存成 application/pdf
await db.prepare(`INSERT INTO labels (id, filename, name_from_file, r2_key, mime, uploaded_at, updated_at)
  VALUES ('legacy-wdfx-1', '舊標籤.wdfx', '舊標籤', 'labels/legacy-wdfx-1.wdfx', 'application/pdf', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
await db.prepare("DELETE FROM meta WHERE key = 'mime_fix_0006'").run();
const staleBefore = await db.prepare(staleSql).first();
check('（前置）有一批舊資料仍被標成 PDF', staleBefore.n > 0, `${staleBefore.n} 筆`);

// 用全新的模組實例模擬「部署後第一次請求」（模組內的 schemaReady 會是 false）
const fresh = await import('../functions/api/[[path]].js?mime-fix=1');
const freshHealth = await fresh.onRequestGet({ request: request('/api/health'), env });
check('額度正常時 /api/health 回 ok', freshHealth.status === 200, String(freshHealth.status));

const staleAfter = await db.prepare(staleSql).first();
check('啟動時自動把非 PDF 標籤改成 octet-stream', staleAfter.n === 0, `剩 ${staleAfter.n} 筆`);
const pdfWrong = await db.prepare("SELECT COUNT(*) AS n FROM labels WHERE filename IS NOT NULL AND lower(filename) LIKE '%.pdf' AND mime <> 'application/pdf'").first();
check('PDF 標籤仍然是 application/pdf', pdfWrong.n === 0, `${pdfWrong.n} 筆不符`);
const legacyRow = await db.prepare("SELECT mime FROM labels WHERE id = 'legacy-wdfx-1'").first();
check('那筆舊資料已被改成 octet-stream', legacyRow && legacyRow.mime === 'application/octet-stream', legacyRow && legacyRow.mime);
await db.prepare("DELETE FROM labels WHERE id = 'legacy-wdfx-1'").run();

const flagRow = await db.prepare("SELECT value FROM meta WHERE key = 'mime_fix_0006'").first();
check('記錄旗標，之後不會重複全表改寫', flagRow && flagRow.value === '1', flagRow && flagRow.value);
const healthAfter = await (await fresh.onRequestGet({ request: request('/api/health'), env })).json();
check('/api/health 會回報 mimeFix 狀態（可在正式站確認遷移做完）', healthAfter.mimeFix === 'done', healthAfter.mimeFix);

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

console.log('\n=== 7e. R2 大表快取（重複開頁不再掃 D1） ===');
const cacheProductCount = (await db.prepare('SELECT COUNT(*) AS n FROM products').first()).n;
const cacheLabelCount = (await db.prepare('SELECT COUNT(*) AS n FROM labels').first()).n;

// 暖機：讓快取與目前 revision 對齊
await api.onRequestGet({ request: request('/api/bootstrap'), env });
check('商品表已快取到 R2', Boolean(await r2.get('cache/products.json')), 'cache/products.json');
check('標籤表已快取到 R2', Boolean(await r2.get('cache/labels.json')), 'cache/labels.json');

// 用 Proxy 包住 D1，數「掃了商品表 / 標籤表幾次」
function countingEnv() {
  const counter = { products: 0, labels: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return sql => {
          const text = String(sql);
          if (/FROM products/i.test(text)) counter.products += 1;
          if (/FROM labels/i.test(text)) counter.labels += 1;
          return target.prepare(sql);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { counter, env: { ...env, DB: proxy } };
}

const warm = countingEnv();
const warmBoot = await (await api.onRequestGet({ request: request('/api/bootstrap'), env: warm.env })).json();
check('暖機後開頁完全不掃商品表（省下 22,481 列讀取）', warm.counter.products === 0, `${warm.counter.products} 次商品表查詢`);
check('暖機後開頁完全不掃標籤表', warm.counter.labels === 0, `${warm.counter.labels} 次標籤表查詢`);
check('快取內容與 D1 一致', warmBoot.products.length === cacheProductCount && warmBoot.labels.length === cacheLabelCount,
  `${warmBoot.products.length}/${cacheProductCount} 商品、${warmBoot.labels.length}/${cacheLabelCount} 標籤`);

const labelHit = countingEnv();
await api.onRequestGet({ request: request('/api/labels'), env: labelHit.env });
await api.onRequestGet({ request: request('/api/labels'), env: labelHit.env });
check('/api/labels 連兩次都走快取', labelHit.counter.labels === 0, `${labelHit.counter.labels} 次標籤表查詢`);

// 快取 revision 不符（例如使用者改了資料）→ 必須忽略快取、重讀 D1，不能給舊資料
await r2.put('cache/labels.json', JSON.stringify({ revision: 'stale-revision', rows: [] }));
const mismatch = countingEnv();
const mismatchBody = await (await api.onRequestGet({ request: request('/api/labels'), env: mismatch.env })).json();
check('快取 revision 不符會被忽略並重讀 D1', mismatch.counter.labels >= 1 && mismatchBody.labels.length === cacheLabelCount,
  `${mismatch.counter.labels} 次查詢、回 ${mismatchBody.labels.length} 筆`);

// 快取物件不見了 → 自動重建，功能不受影響
await r2.delete('cache/products.json');
const cold = countingEnv();
const coldBoot = await (await api.onRequestGet({ request: request('/api/bootstrap'), env: cold.env })).json();
check('快取不見時自動重建商品表', cold.counter.products >= 1 && coldBoot.products.length === cacheProductCount,
  `${cold.counter.products} 次查詢、回 ${coldBoot.products.length} 筆`);
await new Promise(resolve => setTimeout(resolve, 50));
const rewarm = countingEnv();
await api.onRequestGet({ request: request('/api/bootstrap'), env: rewarm.env });
check('重建後又回到 0 次商品表查詢', rewarm.counter.products === 0, `${rewarm.counter.products} 次`);

/* 8. health */
response = await api.onRequestGet({ request: request('/api/health'), env });
const health = await response.json();
check('health 回報 D1/R2 狀態（且附 revision）', health.ok === true && health.r2 === true && Boolean(health.productsRevision), JSON.stringify(health));

/* 9. DELETE */
console.log('\n=== 8. 改標籤名稱（部分更新）與重複標籤批次刪除 ===');
// 先給第一個標籤一個配對，確認「只改名稱」不會把配對洗掉
const targetId = uploaded[0].id;
await api.onRequestPatch({
  request: request(`/api/labels/${encodeURIComponent(targetId)}`, { method: 'PATCH', ...json({
    productId: 1, matchedProductName: '測試商品', matchSource: 'manual', matchConfidence: 'manual'
  }) }),
  env
});
let row = await db.prepare('SELECT product_id AS pid, matched_product_name AS name FROM labels WHERE id = ?').bind(targetId).first();
check('PATCH 可設定配對', row.pid === 1 && row.name === '測試商品', JSON.stringify(row));

const deferRes = await api.onRequestPatch({
  request: request(`/api/labels/${encodeURIComponent(targetId)}`, { method: 'PATCH', ...json({ deferred: true }) }),
  env
});
const deferBody = await deferRes.json();
row = await db.prepare('SELECT deferred, product_id AS pid, matched_product_name AS name FROM labels WHERE id = ?').bind(targetId).first();
check('PATCH 可標記「稍後處理」且不清掉配對', deferBody.ok === true && row.deferred === 1 && row.pid === 1,
  JSON.stringify(row));

const undeferRes = await api.onRequestPatch({
  request: request(`/api/labels/${encodeURIComponent(targetId)}`, { method: 'PATCH', ...json({ deferred: false }) }),
  env
});
await undeferRes.json();
row = await db.prepare('SELECT deferred, name_from_file AS nf FROM labels WHERE id = ?').bind(targetId).first();
check('可以取消「稍後處理」', row.deferred === 0, JSON.stringify(row));

const labelListDeferred = await (await api.onRequestGet({ request: request('/api/labels'), env })).json();
check('/api/labels 會回傳 deferred 欄位', labelListDeferred.labels.every(l => 'deferred' in l),
  `${labelListDeferred.labels.filter(l => l.deferred).length} 筆已延後`);

const renameRes = await api.onRequestPatch({
  request: request(`/api/labels/${encodeURIComponent(targetId)}`, { method: 'PATCH', ...json({ nameFromFile: '修正後名稱' }) }),
  env
});
const renameBody = await renameRes.json();
row = await db.prepare('SELECT name_from_file AS nf, product_id AS pid, matched_product_name AS name, match_source AS src FROM labels WHERE id = ?').bind(targetId).first();
check('只傳 nameFromFile 也能改名', renameBody.ok === true && row.nf === '修正後名稱', JSON.stringify(row));
check('改名不會清掉原本的配對（部分更新）', row.pid === 1 && row.name === '測試商品' && row.src === 'manual', JSON.stringify(row));

const metaBeforeBulk = await (await api.onRequestGet({ request: request('/api/meta'), env })).json();
const bulkIds = [uploaded[1].id, uploaded[2].id];
await api.onRequestPatch({
  request: request(`/api/labels/${encodeURIComponent(bulkIds[0])}`, { method: 'PATCH', ...json({ productId: 2, matchedProductName: '批次刪除用' }) }),
  env
});
const bulkRes = await api.onRequestPost({ request: request('/api/labels/bulk-delete', json({ ids: bulkIds })), env });
const bulkBody = await bulkRes.json();
const left = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
const orphan = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE label_id = ?').bind(bulkIds[0]).first();
check('批次刪除回報刪除筆數', bulkBody.ok === true && bulkBody.deleted === 2, JSON.stringify(bulkBody));
check('D1 標籤數減少 2', left.n === 172, `${left.n}`);
check('被刪標籤的商品連結已清除', orphan.n === 0, `殘留 ${orphan.n}`);
const r2AfterBulk = await r2.list({ prefix: 'labels/' });
check('R2 物件同步刪除', r2AfterBulk.objects.length === 172, `${r2AfterBulk.objects.length} 個`);
const metaAfterBulk = await (await api.onRequestGet({ request: request('/api/meta'), env })).json();
check('批次刪除會遞增 labels_revision', metaAfterBulk.labelsRevision !== metaBeforeBulk.labelsRevision,
  `${metaBeforeBulk.labelsRevision} → ${metaAfterBulk.labelsRevision}`);
const emptyBody = await (await api.onRequestPost({ request: request('/api/labels/bulk-delete', json({ ids: [] })), env })).json();
check('空 ids 會被拒絕', Boolean(emptyBody.error), JSON.stringify(emptyBody));

console.log('\n=== 9. 刪除單一標籤 ===');
const deleteId = uploaded[3].id;   // 1、2 已在批次刪除中移除
response = await api.onRequestDelete({ request: request(`/api/labels/${encodeURIComponent(deleteId)}`, { method: 'DELETE' }), env });
const afterDelete = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
const r2After = await r2.list({ prefix: 'labels/' });
check('刪除後 D1 與 R2 都少一筆', afterDelete.n === 171 && r2After.objects.length === 171, `D1 ${afterDelete.n} / R2 ${r2After.objects.length}`);

/* ------------------------------- 9c. 刪除指定商品（Excel 增量匯入用） */
console.log('\n=== 9c. 刪除指定商品（增量匯入） ===');
const beforeProducts = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
const victim = await db.prepare('SELECT id, name FROM products LIMIT 1').first();
const victimLabel = uploaded.find(l => l.productId == null) || uploaded[0];
await db.prepare('UPDATE labels SET product_id = ?, matched_product_name = ?, match_source = ? WHERE id = ?')
  .bind(victim.id, victim.name, 'manual', victimLabel.id).run();
await db.prepare('UPDATE products SET label_id = ? WHERE id = ?').bind(victimLabel.id, victim.id).run();

const delNone = await api.onRequestPost({ request: request('/api/products/delete', { method: 'POST', ...json({}) }), env });
check('沒有 ids → 400', delNone.status === 400, String(delNone.status));

const delTooMany = await api.onRequestPost({
  request: request('/api/products/delete', { method: 'POST', ...json({ ids: Array.from({ length: 301 }, (_, i) => i + 1) }) }),
  env
});
check('一次超過 300 筆 → 400（要求分批）', delTooMany.status === 400, String(delTooMany.status));

const delOk = await api.onRequestPost({
  request: request('/api/products/delete', { method: 'POST', ...json({ ids: [victim.id] }) }),
  env
});
const delBody = await delOk.json();
check('刪除 1 個商品 → 回報 1 筆', delBody.ok === true && delBody.deletedProducts === 1, JSON.stringify(delBody));
check('指向被刪商品的標籤會解除配對', delBody.unlinkedLabels === 1, JSON.stringify(delBody));
const afterProducts = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
check('商品總數少 1', afterProducts.n === beforeProducts.n - 1, `${beforeProducts.n} → ${afterProducts.n}`);
const orphanLabel = await db.prepare('SELECT product_id AS pid, matched_product_name AS name, match_source AS src FROM labels WHERE id = ?').bind(victimLabel.id).first();
check('該標籤變成未配對（但檔案還在）', orphanLabel.pid === null && orphanLabel.name === null && orphanLabel.src === null,
  JSON.stringify(orphanLabel));
const stillThere = await db.prepare('SELECT COUNT(*) AS n FROM labels WHERE id = ?').bind(victimLabel.id).first();
check('標籤本身沒有被刪除', stillThere.n === 1, String(stillThere.n));

/* ------------------- 9d. labels/sync 支援改名，且不應改動 products_revision */
console.log('\n=== 9d. 批次同步支援改名（且不燒商品版本） ===');
const metaBeforeSync = await (await api.onRequestGet({ request: request('/api/meta'), env })).json();
const survivors = (await db.prepare('SELECT id, name_from_file AS nf FROM labels ORDER BY uploaded_at LIMIT 3').all()).results || [];
const syncTarget = survivors[0];
const keepName = survivors[1];
await api.onRequestPost({
  request: request('/api/labels/sync', json({
    labels: [{ id: syncTarget.id, productId: 1, matchedProductName: '測試商品', matchSource: 'manual', nameFromFile: '批次改名後的名稱' }]
  })),
  env
});
const synced = await db.prepare('SELECT name_from_file AS nf, product_id AS pid FROM labels WHERE id = ?').bind(syncTarget.id).first();
check('labels/sync 會更新名稱（改名可批次補送）', synced.nf === '批次改名後的名稱', JSON.stringify(synced));
check('labels/sync 會更新配對', synced.pid === 1, JSON.stringify(synced));
const metaAfterSync = await (await api.onRequestGet({ request: request('/api/meta'), env })).json();
check('配對／改名會遞增 labels_revision', Number(metaAfterSync.labelsRevision) > Number(metaBeforeSync.labelsRevision),
  `${metaBeforeSync.labelsRevision} → ${metaAfterSync.labelsRevision}`);
check('配對／改名「不會」遞增 products_revision（否則每次開頁都要重讀 22,481 列）',
  metaAfterSync.productsRevision === metaBeforeSync.productsRevision,
  `${metaBeforeSync.productsRevision} → ${metaAfterSync.productsRevision}`);
const noName = await db.prepare('SELECT name_from_file AS nf FROM labels WHERE id = ?').bind(keepName.id).first();
await api.onRequestPost({
  request: request('/api/labels/sync', json({ labels: [{ id: keepName.id, productId: null, matchedProductName: null }] })),
  env
});
const noNameAfter = await db.prepare('SELECT name_from_file AS nf FROM labels WHERE id = ?').bind(keepName.id).first();
check('沒有帶名稱時不會把名稱清空', noNameAfter.nf === noName.nf, `${noName.nf} → ${noNameAfter.nf}`);

console.log('\n=== 9b. 清除雲端資料 ===');
const clearWrong = await (await api.onRequestPost({
  request: request('/api/cloud/clear', json({ scope: 'labels', confirm: '清' })), env
})).json();
check('沒有輸入正確確認字串會被拒絕', Boolean(clearWrong.error), JSON.stringify(clearWrong));

const clearBadScope = await (await api.onRequestPost({
  request: request('/api/cloud/clear', json({ scope: 'everything', confirm: '清除' })), env
})).json();
check('scope 不合法會被拒絕', Boolean(clearBadScope.error), JSON.stringify(clearBadScope));

const leftBefore = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
const clearLabels = await (await api.onRequestPost({
  request: request('/api/cloud/clear', json({ scope: 'labels', confirm: '清除' })), env
})).json();
const labelsLeft = await db.prepare('SELECT COUNT(*) AS n FROM labels').first();
const r2Left = await r2.list({ prefix: 'labels/' });
const productsLeft = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
const linkedLeft = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE label_id IS NOT NULL').first();
check('清除標籤：D1 標籤歸零', clearLabels.ok === true && labelsLeft.n === 0, `回報 ${clearLabels.deletedLabels}，剩 ${labelsLeft.n}`);
check('清除標籤：R2 檔案歸零', r2Left.objects.length === 0, `剩 ${r2Left.objects.length} 個（刪了 ${clearLabels.deletedObjects}）`);
check('清除標籤：商品沒有被刪', productsLeft.n === leftBefore.n, `${leftBefore.n} → ${productsLeft.n}`);
check('清除標籤：商品的 label_id 已清空', linkedLeft.n === 0, `殘留 ${linkedLeft.n}`);

const clearProducts = await (await api.onRequestPost({
  request: request('/api/cloud/clear', json({ scope: 'products', confirm: '清除' })), env
})).json();
const productsAfter = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
check('清除商品：商品歸零', clearProducts.ok === true && productsAfter.n === 0, `回報 ${clearProducts.deletedProducts}，剩 ${productsAfter.n}`);

/* 10. 未設定 binding 的友善錯誤 */
response = await api.onRequestGet({ request: request('/api/bootstrap'), env: {} });
check('缺少 DB binding 時回 503 與清楚訊息', response.status === 503, (await response.json()).error);

const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) console.log('失敗項目：', failed.map(f => f.name).join(' | '));

await mf.dispose();
process.exit(failed.length ? 1 : 0);
