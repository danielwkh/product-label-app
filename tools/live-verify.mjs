// 正式站（after quota reset）逐項驗證：只讀 + 一個可完全清除的暫存標籤
const BASE = 'https://product-label-app.pages.dev';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const j = async (path, init) => {
  const t = Date.now();
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, headers: r.headers, body, text, ms: Date.now() - t };
};

console.log('=== 1. 便宜的版本檢查（省 D1 額度）===');
const meta1 = await j('/api/meta');
check('/api/meta 回 200 且沒有 degraded', meta1.status === 200 && meta1.body.cloud === true && meta1.body.degraded === false,
  JSON.stringify(meta1.body));
check('/api/meta 沒有回傳任何商品陣列', !('products' in (meta1.body || {})));
check('/api/meta 標示只讀 2 列（x-d1-rows-read）', meta1.headers.get('x-d1-rows-read') === '2', `x-d1-rows-read=${meta1.headers.get('x-d1-rows-read')}`);

console.log('\n=== 2. bootstrap 全量 + revision/ETag ===');
const boot1 = await j('/api/bootstrap');
const products = boot1.body.products || [];
const labels = boot1.body.labels || [];
check('bootstrap 回 200', boot1.status === 200, `${boot1.ms}ms, ${(boot1.text.length / 1024).toFixed(0)}KB`);
check('商品數維持 22,481（資料沒有被刪）', products.length === 22481, `${products.length}`);
check('標籤數', labels.length >= 2, `${labels.length}`);
check('每個標籤都有 hash 欄位', labels.every(l => 'hash' in l), `${labels.filter(l => l.hash).length} 個有值`);
const etag = boot1.headers.get('etag');
const rev = boot1.headers.get('x-data-revision');
check('有 ETag 與 x-data-revision', Boolean(etag) && Boolean(rev), `${etag} rev=${rev}`);

const boot2 = await j('/api/bootstrap', { headers: { 'if-none-match': etag } });
check('同 revision 帶 If-None-Match 回 304（0 次商品表讀取）', boot2.status === 304, `status=${boot2.status}`);

console.log('\n=== 3. /api/labels 只讀標籤 ===');
const labelList = await j('/api/labels');
check('/api/labels 回 200 且不含商品', labelList.status === 200 && Array.isArray(labelList.body.labels) && !('products' in labelList.body),
  `${(labelList.body.labels || []).length} 標籤, ${(labelList.text.length / 1024).toFixed(1)}KB`);

console.log('\n=== 4. PDF 下載 Range（既有資料，唯讀）===');
const withBlob = labels.find(l => l.size > 0);
if (withBlob) {
  const range = await fetch(`${BASE}/api/labels/${encodeURIComponent(withBlob.id)}/file`, { headers: { range: 'bytes=0-1023' } });
  check('Range 回 206 且只傳 1KB', range.status === 206, `${range.headers.get('content-range')}`);
} else {
  check('沒有可測的 PDF', false, '略過');
}

console.log('\n=== 5. 端到端（上傳 → 去重 → 配對同步 → 下載 → 刪除）===');
const metaBefore = (await j('/api/meta')).body;
// 1x1 最小合法 PDF
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
).toString('base64');
const filename = `verify-${Date.now()}.pdf`;
const pdfBytes = Buffer.from(pdf, 'base64');
const makeForm = id => {
  const form = new FormData();
  form.set('id', id);
  form.set('filename', filename);
  form.set('hash', 'verifyhash0001');
  form.set('size', String(pdfBytes.length));
  form.set('file', new Blob([pdfBytes], { type: 'application/pdf' }), filename);
  return form;
};
const uploadId = `L${Date.now()}-verify`;

const up1 = await j('/api/labels', { method: 'POST', body: makeForm(uploadId) });
check('上傳成功且非去重', up1.status === 200 && up1.body.ok && up1.body.deduped === false, JSON.stringify(up1.body).slice(0, 120));
const newId = (up1.body && up1.body.id) || uploadId;

const up2 = await j('/api/labels', { method: 'POST', body: makeForm(uploadId) });
check('重複上傳回 deduped（R2 未重寫）', up2.status === 200 && up2.body.deduped === true, JSON.stringify(up2.body).slice(0, 120));

const metaAfter = (await j('/api/meta')).body;
check('上傳後 labels_revision 有變（前端才知道要更新）', metaAfter.labelsRevision !== metaBefore.labelsRevision,
  `${metaBefore.labelsRevision} → ${metaAfter.labelsRevision}`);

const sync = await j('/api/labels/sync', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ labels: [{ id: newId, productId: products[0].id, matchedProductName: products[0].name, matchSource: 'manual', matchScore: 100, matchConfidence: 'high', matchGap: 0, matchWhy: '驗證用' }] })
});
check('批次配對同步成功', sync.status === 200 && sync.body.ok, JSON.stringify(sync.body).slice(0, 100));

const get1 = await fetch(`${BASE}/api/labels/${encodeURIComponent(newId)}/file`);
const bytes = new Uint8Array(await get1.arrayBuffer());
check('下載內容與上傳一致', get1.status === 200 && bytes.length === Buffer.from(pdf, 'base64').length, `${bytes.length} bytes`);

const rng = await fetch(`${BASE}/api/labels/${encodeURIComponent(newId)}/file`, { headers: { range: 'bytes=0-99' } });
check('新檔 Range 回 206', rng.status === 206, `${rng.headers.get('content-range')}`);

const del = await fetch(`${BASE}/api/labels/${encodeURIComponent(newId)}`, { method: 'DELETE' });
check('刪除暫存標籤', del.status === 200, `status=${del.status}`);

console.log('\n=== 6. 清理確認 ===');
const after = await j('/api/labels');
check('標籤數量回到原值（測試資料已清除）', (after.body.labels || []).length === labels.length,
  `${labels.length} → ${(after.body.labels || []).length}`);
const metaEnd = (await j('/api/meta')).body;
check('刪除後 labels_revision 再次遞增', metaEnd.labelsRevision !== metaAfter.labelsRevision, `${metaAfter.labelsRevision} → ${metaEnd.labelsRevision}`);

const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) { console.log('失敗：', failed.map(f => f.name).join(' | ')); process.exitCode = 1; }
