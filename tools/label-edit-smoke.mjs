/*
 * 標籤編輯 / 重複管理 的瀏覽器層級測試（JSDOM）
 *
 * 驗證使用者要的功能：
 *   1. 重複標籤偵測（同內容 hash）→ 篩選、標記、統計數字
 *   2. 「保留這筆，刪除其他 N 筆」（人工配對優先）
 *   3. 「每組只留一筆」
 *   4. 改標籤名稱（本機 IndexedDB 同步）
 *   5. 刪除單筆 / 批次刪除（含 Blob 只在不共用時才刪）
 *
 * 執行：node tools/label-edit-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'https://product-label-app.pages.dev/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
Object.defineProperty(globalThis.navigator, 'storage', {
  value: { estimate: async () => ({ quota: 4 * 1024 * 1024 * 1024, usage: 0 }), persist: async () => true },
  configurable: true
});
Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Worker = undefined;
globalThis.fetch = async () => { throw new Error('離線測試環境'); };
window.confirm = () => true;          // 自動確認刪除對話框
globalThis.confirm = () => true;      // app.js 在 Node 環境執行，需要全域的 confirm
window.alert = () => {};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await import('../js/app.js');
await new Promise(r => setTimeout(r, 150));
const db = await import('../js/store/db.js');
const state = window.app.state;

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------- 建立測試資料 */
console.log('=== 準備測試資料 ===');
const now = new Date().toISOString();
const makeLabel = (id, hash, name, extra = {}) => ({
  id, filename: `${name}.pdf`, nameFromFile: name, hash, size: 1024,
  productId: null, matchedProductName: null, matchSource: null,
  uploadedAt: now, updatedAt: now, uploaded: false, hasLocalBlob: true, ...extra
});

const labels = [
  // 一組 3 筆重複（同 hash）：其中第二筆是人工配對 → 應該被保留
  makeLabel('dupA-1', 'hash-dup-1', '洗髮精 400ml', { uploadedAt: '2026-11-01T00:00:00Z' }),
  makeLabel('dupA-2', 'hash-dup-1', '洗髮精-複本', {
    uploadedAt: '2026-11-02T00:00:00Z', productId: 11, matchedProductName: '洗髮精 400ml',
    matchSource: 'manual', matchConfidence: 'manual'
  }),
  makeLabel('dupA-3', 'hash-dup-1', 'IMG_0042', { uploadedAt: '2026-11-03T00:00:00Z' }),
  // 一組 2 筆重複，都沒有配對 → 保留最新
  makeLabel('dupB-1', 'hash-dup-2', '沐浴乳 1L', { uploadedAt: '2026-11-01T10:00:00Z' }),
  makeLabel('dupB-2', 'hash-dup-2', 'IMG_0099', { uploadedAt: '2026-11-04T10:00:00Z' }),
  // 正常、不重複
  makeLabel('single-1', 'hash-solo', '潤髮乳 250ml', {
    productId: 12, matchedProductName: '潤髮乳 250ml', matchSource: 'auto', matchScore: 90, matchConfidence: 'high'
  })
];

state.labels = {};
for (const label of labels) state.labels[label.id] = { ...label };
state.cloudEnabled = false;
for (const label of labels) {
  await db.putLabel(label);
  await db.putBlob(label.hash, new Blob([new Uint8Array(1024)], { type: 'application/pdf' }));
}
window.app.renderMatchList();
console.log(`  已建立 ${labels.length} 筆標籤（2 組重複）`);

/* ------------------------------------------------ 1. 重複偵測 */
console.log('\n=== 1. 重複偵測與顯示 ===');
const dupMap = window.app.duplicateMap(Object.values(state.labels));
check('偵測到 5 筆屬於重複群組', dupMap.size === 5, `${dupMap.size}`);
check('每組筆數正確（3 與 2）', dupMap.get('dupA-1').size === 3 && dupMap.get('dupB-1').size === 2,
  `${dupMap.get('dupA-1').size} / ${dupMap.get('dupB-1').size}`);
check('同內容的重複標記為 content', dupMap.get('dupA-1').type === 'content', dupMap.get('dupA-1').type);
const extras = window.app.extraDuplicateIds(Object.values(state.labels));
check('多餘筆數 = 3（每組保留一筆）', extras.length === 3, `${extras.join(', ')}`);
check('多餘清單保留人工配對那筆', !extras.includes('dupA-2') && extras.includes('dupA-1') && extras.includes('dupA-3'),
  extras.join(', '));
check('篩選器上的數字顯示 3', document.getElementById('dupCount').textContent === '3',
  document.getElementById('dupCount').textContent);

// 切到「重複」篩選
document.querySelector('.filter-btn[data-filter="dup"]').dispatchEvent(new window.Event('click'));
await wait(30);
const dupRows = [...document.querySelectorAll('#matchList .label-item')];
check('重複篩選只顯示 5 筆', dupRows.length === 5, `${dupRows.length}`);
check('列表上有「重複 ×3」標記', /重複 ×3/.test(document.getElementById('matchList').textContent));
check('有「保留這筆，刪除其他」按鈕', /保留這筆，刪除其他/.test(document.getElementById('matchList').textContent));

/* ------------------------------------- 2. 保留指定那筆（人工配對） */
console.log('\n=== 2. 保留這筆，刪除其他 ===');
const keepBtn = document.querySelector('#matchList button[data-action="keep"][data-id="dupA-2"]');
check('找到 dupA-2 的保留按鈕', Boolean(keepBtn));
keepBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(300);
check('該組只剩 1 筆', !state.labels['dupA-1'] && !state.labels['dupA-3'] && Boolean(state.labels['dupA-2']),
  Object.keys(state.labels).join(', '));
check('保留的是人工配對那筆', state.labels['dupA-2'].matchedProductName === '洗髮精 400ml');
check('IndexedDB 也刪掉了', !(await db.getLabel('dupA-1')) && !(await db.getLabel('dupA-3')));
check('共用的 Blob 沒有被刪掉（還有標籤在用）', await db.hasBlob('hash-dup-1'));
check('其他組不受影響', Boolean(state.labels['dupB-1']) && Boolean(state.labels['dupB-2']));

/* ------------------------------------------- 3. 每組只留一筆 */
console.log('\n=== 3. 每組只留一筆（橫幅按鈕）===');
document.querySelector('.filter-btn[data-filter="all"]').dispatchEvent(new window.Event('click'));
await wait(30);
document.getElementById('dupKeepOneBtn').dispatchEvent(new window.Event('click'));
await wait(300);
check('只剩 3 筆標籤（dupA-2 / dupB-2 / single-1）',
  Object.keys(state.labels).sort().join(',') === 'dupA-2,dupB-2,single-1', Object.keys(state.labels).join(','));
check('第二組保留最新上傳的那筆', Boolean(state.labels['dupB-2']));
check('重複數字歸零', document.getElementById('dupCount').textContent === '0');
check('重複橫幅已隱藏', document.getElementById('dupBanner').style.display === 'none');

/* ------------------------------- 3b. 同名不同檔（PDF 與轉檔後的 .wdfx） */
console.log('\n=== 3b. 同名不同檔（PDF ↔ .wdfx）===');
const nowIso = new Date().toISOString();
const pairPdf = { ...makeLabel('pair-pdf', 'hash-pdf-1', '白象老母雞湯麵585克標籤_7x4'), filename: '白象老母雞湯麵585克標籤_7x4.pdf', uploadedAt: nowIso };
const pairWdfx = { ...makeLabel('pair-wdfx', 'hash-wdfx-1', '白象老母雞湯麵585克標籤_7x4'), filename: '白象老母雞湯麵585克標籤_7x4.wdfx', kind: 'file', ext: 'wdfx', mime: 'application/octet-stream' };
state.labels['pair-pdf'] = pairPdf;
state.labels['pair-wdfx'] = pairWdfx;
await db.putLabel(pairPdf);
await db.putLabel(pairWdfx);
window.app.renderMatchList();
await wait(50);
const dupMap2 = window.app.duplicateMap(Object.values(state.labels));
check('同名不同檔會被判定為重複', Boolean(dupMap2.get('pair-pdf')) && Boolean(dupMap2.get('pair-wdfx')),
  JSON.stringify(dupMap2.get('pair-pdf')));
check('標記為 name（不是 content）', dupMap2.get('pair-pdf').type === 'name', dupMap2.get('pair-pdf').type);
check('列表顯示「同名 ×2」', /同名 ×2/.test(document.getElementById('matchList').textContent));
const extras2 = window.app.extraDuplicateIds(Object.values(state.labels));
check('同名群組會列出一筆多餘', extras2.filter(id => id === 'pair-pdf' || id === 'pair-wdfx').length === 1,
  extras2.join(', '));
// 使用者選擇保留 .wdfx（因為要給 WePrint 用）
document.querySelector('#matchList button[data-action="keep"][data-id="pair-wdfx"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(300);
check('保留 .wdfx 後 PDF 那筆被刪除', Boolean(state.labels['pair-wdfx']) && !state.labels['pair-pdf'],
  Object.keys(state.labels).join(', '));

/* --------------------------------------------------- 4. 改標籤名稱 */
console.log('\n=== 4. 修改標籤名稱 ===');
window.app.openEditLabelModal('single-1');
check('編輯視窗有帶入目前名稱', document.getElementById('editLabelNameInput').value === '潤髮乳 250ml',
  document.getElementById('editLabelNameInput').value);
check('視窗顯示目前配對', /目前配對：潤髮乳 250ml/.test(document.getElementById('editLabelMatchInfo').textContent));
document.getElementById('editLabelNameInput').value = '潤髮乳 250ml 補充包';
document.getElementById('editLabelSaveBtn').dispatchEvent(new window.Event('click'));
await wait(200);
check('記憶體中的名稱已更新', state.labels['single-1'].nameFromFile === '潤髮乳 250ml 補充包');
const stored = await db.getLabel('single-1');
check('IndexedDB 中的名稱已更新', stored && stored.nameFromFile === '潤髮乳 250ml 補充包', stored && stored.nameFromFile);
check('配對資料沒有被改名洗掉', stored.productId === 12 && stored.matchSource === 'auto');
check('編輯視窗已關閉', !document.getElementById('editLabelModal').classList.contains('show'));
check('列表顯示新名稱', document.getElementById('matchList').textContent.includes('潤髮乳 250ml 補充包'));

/* --------------------------------------------------- 5. 刪除單筆 */
console.log('\n=== 5. 刪除單筆標籤 ===');
const before = Object.keys(state.labels).length;
document.querySelector('#matchList button[data-action="delete"][data-id="dupB-2"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(300);
check('標籤數 -1', Object.keys(state.labels).length === before - 1, `${before} → ${Object.keys(state.labels).length}`);
check('IndexedDB 記錄已刪除', !(await db.getLabel('dupB-2')));
check('Blob 已刪除（沒有其他標籤共用）', !(await db.hasBlob('hash-dup-2')));
check('統計數字同步更新', document.getElementById('statLabels').textContent === String(before - 1),
  document.getElementById('statLabels').textContent);

/* ------------------------------------------- 6. 批次刪除（勾選） */
console.log('\n=== 6. 勾選後批次刪除 ===');
state.labels['extra-1'] = makeLabel('extra-1', 'hash-x1', '多餘檔案 A');
state.labels['extra-2'] = makeLabel('extra-2', 'hash-x2', '多餘檔案 B');
await db.putLabel(state.labels['extra-1']);
await db.putLabel(state.labels['extra-2']);
state.selectedLabelIds = new Set(['extra-1', 'extra-2']);
window.app.renderMatchList();
document.getElementById('bulkDeleteBtn').dispatchEvent(new window.Event('click'));
await wait(300);
check('兩筆都被刪除', !state.labels['extra-1'] && !state.labels['extra-2'], Object.keys(state.labels).join(', '));
check('選取清單已清空', state.selectedLabelIds.size === 0);
check('剩下 dupA-2、single-1、pair-wdfx', Object.keys(state.labels).sort().join(',') === 'dupA-2,pair-wdfx,single-1',
  Object.keys(state.labels).join(','));
check('本機只剩下 2 個 Blob（pair-wdfx 沒有本機檔）', (await db.blobBytes()).count === 2, `${(await db.blobBytes()).count}`);

/* ------------------------------- 7. 雲端路徑（改名 / 批次刪除的請求內容） */
console.log('\n=== 7. 有雲端時的請求內容 ===');
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method || 'GET', body: init.body });
  return new Response(JSON.stringify({ ok: true, deleted: 1, ids: [] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};
state.cloudEnabled = true;

state.labels['cloud-1'] = makeLabel('cloud-1', 'hash-c1', '雲端標籤 A', { uploaded: true });
state.labels['cloud-2'] = makeLabel('cloud-2', 'hash-c2', '雲端標籤 B', { uploaded: true });
await db.putLabel(state.labels['cloud-1']);
await db.putLabel(state.labels['cloud-2']);
window.app.renderMatchList();

await window.app.renameLabel('cloud-1', '雲端標籤 A（修正）');
await wait(150);
const patchReq = requests.find(r => r.method === 'PATCH');
check('改名會送 PATCH 到 /api/labels/:id', Boolean(patchReq && patchReq.url.includes('/api/labels/cloud-1')),
  patchReq && `${patchReq.method} ${patchReq.url}`);
check('PATCH 只送 nameFromFile（不會洗掉配對）',
  Boolean(patchReq) && Object.keys(JSON.parse(patchReq.body)).join(',') === 'nameFromFile',
  patchReq && patchReq.body);

requests.length = 0;
state.selectedLabelIds = new Set(['cloud-1', 'cloud-2']);
window.app.renderMatchList();
document.getElementById('bulkDeleteBtn').dispatchEvent(new window.Event('click'));
await wait(300);
const bulkReq = requests.find(r => r.url.includes('bulk-delete'));
check('多筆刪除走 POST /api/labels/bulk-delete', Boolean(bulkReq), bulkReq && bulkReq.method);
check('送出正確的 ids', Boolean(bulkReq) && JSON.parse(bulkReq.body).ids.join(',') === 'cloud-1,cloud-2',
  bulkReq && bulkReq.body);
check('雲端標籤已從畫面移除', !state.labels['cloud-1'] && !state.labels['cloud-2']);
state.cloudEnabled = false;

/* ------------------------------- 8. 分頁順序與清除雲端資料按鈕 */
console.log('\n=== 8. 分頁順序與清除雲端資料 ===');
const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.trim());
check('第一個分頁是「掃碼台」', tabs[0].includes('掃碼台'), tabs.join(' / '));
check('第二個分頁是「搜尋」', tabs[1].includes('搜尋'), tabs.join(' / '));
check('最後一個分頁是「上傳」', tabs[tabs.length - 1] === '上傳', tabs.join(' / '));
check('預設顯示掃碼台面板', document.getElementById('panel-scan').classList.contains('active'));
check('搜尋面板預設隱藏', !document.getElementById('panel-search').classList.contains('active'));
check('上傳面板預設隱藏', !document.getElementById('panel-upload').classList.contains('active'));

state.cloudEnabled = true;
state.products = [{ id: 1, name: '測試商品 A' }, { id: 2, name: '測試商品 B' }];
state.labels = {
  'k1': makeLabel('k1', 'hash-k1', '要清掉的標籤')
};
window.app.renderMatchList();
window.app.openClearCloudModal();
check('清除視窗會顯示目前筆數', /1/.test(document.getElementById('clearCloudCounts').textContent)
  && /2/.test(document.getElementById('clearCloudCounts').textContent),
  document.getElementById('clearCloudCounts').textContent);
check('確認按鈕一開始是停用的', document.getElementById('clearCloudConfirmBtn').disabled);
const confirmInput = document.getElementById('clearCloudConfirmInput');
confirmInput.value = '清';
confirmInput.dispatchEvent(new window.Event('input'));
check('輸入「清」仍不能按', document.getElementById('clearCloudConfirmBtn').disabled);
confirmInput.value = '清除';
confirmInput.dispatchEvent(new window.Event('input'));
check('輸入「清除」後按鈕才啟用', !document.getElementById('clearCloudConfirmBtn').disabled);

const clearCalls = [];
globalThis.fetch = async (url, init = {}) => {
  clearCalls.push({ url: String(url), body: init.body });
  return new Response(JSON.stringify({ ok: true, deletedLabels: 1, deletedProducts: 0, deletedObjects: 1 }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
document.getElementById('clearCloudConfirmBtn').dispatchEvent(new window.Event('click'));
await wait(500);
check('會呼叫 POST /api/cloud/clear', clearCalls.some(c => c.url.includes('cloud/clear')),
  clearCalls.map(c => c.url).join(', '));
check('送出 scope 與確認字串', (() => {
  const call = clearCalls.find(c => c.url.includes('cloud/clear'));
  const body = JSON.parse(call.body);
  return body.scope === 'labels' && body.confirm === '清除';
})(), clearCalls.find(c => c.url.includes('cloud/clear'))?.body);
check('清除後本機標籤也清空（避免又同步回去）', Object.keys(state.labels).length === 0,
  Object.keys(state.labels).join(', '));
check('商品沒有被清掉', state.products.length === 2, `${state.products.length}`);
check('視窗已關閉', !document.getElementById('clearCloudModal').classList.contains('show'));

/* ------------------------- 9. 只保留 .wdfx（配對要轉移過去） */
console.log('\n=== 9. 每組只保留 .wdfx ===');
state.cloudEnabled = false;
state.labels = {};
state.products = [{ id: 501, name: '白象老母雞湯麵585克', labelId: 'w-pdf-matched' }];
const mkPair = (id, name, ext, extra = {}) => ({
  ...makeLabel(id, `hash-${id}`, name),
  filename: `${name}.${ext}`, ext, kind: ext === 'pdf' ? 'pdf' : 'file',
  mime: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream', uploaded: false, ...extra
});
const pairSet = [
  // A 組：PDF 有人工配對，wdfx 沒有 → 配對要搬到 wdfx
  mkPair('w-pdf-matched', '白象老母雞湯麵585克', 'pdf', { productId: 501, matchedProductName: '白象老母雞湯麵585克', matchSource: 'manual', matchConfidence: 'manual' }),
  mkPair('w-wdfx-plain', '白象老母雞湯麵585克', 'wdfx'),
  // B 組：wdfx 自己就有配對 → 直接留 wdfx
  mkPair('w-pdf-plain', '一町刀削麵', 'pdf'),
  mkPair('w-wdfx-matched', '一町刀削麵', 'wdfx', { productId: 502, matchedProductName: '一町刀削麵', matchSource: 'manual' }),
  // C 組：只有 PDF，沒有 wdfx → 不能被「只留 wdfx」動到
  mkPair('w-only-pdf', '孤兒 PDF 商品', 'pdf')
];
for (const label of pairSet) {
  state.labels[label.id] = label;
  await db.putLabel(label);
}
window.app.renderMatchList();
check('格式統計正確', /PDF 3 個 · WDFX 2 個/.test(document.getElementById('formatInfo').textContent),
  document.getElementById('formatInfo').textContent);

const summary = window.app.formatSummary();
check('知道哪些 PDF 沒有 .wdfx 版本', summary.pdfWithoutTwin.length === 1 && summary.pdfWithoutTwin[0].id === 'w-only-pdf',
  summary.pdfWithoutTwin.map(l => l.id).join(','));
check('知道哪些 PDF 有 .wdfx 版本', summary.pdfWithTwin.length === 2, summary.pdfWithTwin.map(l => l.id).join(','));

await window.app.keepOnlyWdfx();
await wait(400);
check('有 .wdfx 版本的 PDF 都被刪除', !state.labels['w-pdf-matched'] && !state.labels['w-pdf-plain'],
  Object.keys(state.labels).join(','));
check('沒有 .wdfx 的孤兒 PDF 保留', Boolean(state.labels['w-only-pdf']));
check('配對已轉移到 .wdfx', state.labels['w-wdfx-plain'].matchedProductName === '白象老母雞湯麵585克'
  && state.labels['w-wdfx-plain'].matchSource === 'manual',
  `${state.labels['w-wdfx-plain'].matchedProductName} / ${state.labels['w-wdfx-plain'].matchSource}`);
check('原本有配對的 .wdfx 配對沒有被覆蓋', state.labels['w-wdfx-matched'].matchedProductName === '一町刀削麵');
check('商品的 labelId 指向新的 .wdfx', state.products[0].labelId === 'w-wdfx-plain', state.products[0].labelId);
const storedWdfx = await db.getLabel('w-wdfx-plain');
check('IndexedDB 上的配對也更新了', storedWdfx && storedWdfx.productId === 501, storedWdfx && storedWdfx.productId);
check('狀態列說明還有 1 個 PDF 沒有 .wdfx 版本', /還有 1 個 PDF 沒有 .wdfx 版本/.test(document.getElementById('pdfStatus').textContent),
  document.getElementById('pdfStatus').textContent.slice(0, 60));

/* -------------------------------- 10. 刪除所有 PDF（含沒有 wdfx 的孤兒） */
console.log('\n=== 10. 刪除所有 PDF ===');
await window.app.deleteAllPdf();
await wait(400);
check('所有 PDF 都刪除', window.app.formatSummary().pdf.length === 0, `剩 ${window.app.formatSummary().pdf.length}`);
check('只留下 .wdfx', Object.keys(state.labels).sort().join(',') === 'w-wdfx-matched,w-wdfx-plain',
  Object.keys(state.labels).join(','));
check('按鈕在沒有 PDF 時會被停用', (() => { window.app.renderMatchList(); return document.getElementById('deletePdfBtn').disabled; })());

/* ------------------------------- 11. 稍後處理（未配對壓到最後面） */
console.log('\n=== 11. 稍後處理 ===');
state.cloudEnabled = false;
state.labels = {};
const mk = (id, name, extra = {}) => ({ ...makeLabel(id, `hash-${id}`, name), ...extra });
const deferSet = [
  mk('d-unmatched-1', '商品庫沒有的 A'),
  mk('d-matched', '已配對的 B', { productId: 1, matchedProductName: '已配對的 B', matchSource: 'manual' }),
  mk('d-unmatched-2', '商品庫沒有的 C')
];
for (const label of deferSet) { state.labels[label.id] = label; await db.putLabel(label); }
state.matchFilter = 'all';
state.selectedLabelIds = new Set();
window.app.renderMatchList();
await wait(30);

const firstIds = () => [...document.querySelectorAll('#matchList .label-item input.match-check')].map(i => i.dataset.labelId);
check('預設排序（配對狀態）下順序固定', firstIds().length === 3, firstIds().join(','));

await window.app.setDeferred(['d-unmatched-1'], true);
await wait(120);
const order = firstIds();
check('延後後該筆排到最後', order[order.length - 1] === 'd-unmatched-1', order.join(','));
check('清單顯示「已延後」標記', /已延後/.test(document.getElementById('matchList').textContent));
check('篩選器上的延後數字是 1', document.getElementById('deferredCount').textContent === '1',
  document.getElementById('deferredCount').textContent);
check('未配對統計不含已延後的', /未配對 1/.test(document.getElementById('matchSummary').textContent),
  document.getElementById('matchSummary').textContent);
check('IndexedDB 有記住延後狀態', (await db.getLabel('d-unmatched-1')).deferred === true);

// 「未配對」篩選不應包含已延後的那筆
document.querySelector('.filter-btn[data-filter="unmatched"]').dispatchEvent(new window.Event('click'));
await wait(50);
check('「未配對」清單不含已延後項目', !firstIds().includes('d-unmatched-1'), firstIds().join(','));

// 「已延後」篩選只看得到它
document.querySelector('.filter-btn[data-filter="deferred"]').dispatchEvent(new window.Event('click'));
await wait(50);
check('「已延後」篩選只看得到延後項目', firstIds().join(',') === 'd-unmatched-1', firstIds().join(','));

// 批次：把未配對的全部延後
document.querySelector('.filter-btn[data-filter="all"]').dispatchEvent(new window.Event('click'));
await wait(30);
await window.app.deferAllUnmatched();
await wait(300);
check('一鍵延後所有未配對', state.labels['d-unmatched-1'].deferred && state.labels['d-unmatched-2'].deferred);
check('已配對的不受影響', !state.labels['d-matched'].deferred);
check('延後數字變成 2', document.getElementById('deferredCount').textContent === '2',
  document.getElementById('deferredCount').textContent);
check('取消延後可以還原', await (async () => {
  await window.app.setDeferred(['d-unmatched-2'], false);
  return state.labels['d-unmatched-2'].deferred === false;
})());

/* ------------------------------- 12. Excel 增量匯入（先比對、只送變更） */
console.log('\n=== 12. Excel 比對（增量匯入） ===');

const cur = [
  { id: 1, name: '可樂 330ml', barcode: '111', barcode2: '', labelId: null },
  { id: 2, name: '雪碧 330ml', barcode: '222', barcode2: '', labelId: 'L-2' },
  { id: 3, name: '停售商品 A', barcode: '333', barcode2: '', labelId: 'L-3' }
];
const incoming = [
  { id: 1, name: '可樂 330ml', barcode: '111', barcode2: '' },            // 未變
  { id: 2, name: '雪碧 330ml 新包裝', barcode: '222', barcode2: '' },      // 修改
  { id: 4, name: '新商品 B', barcode: '444', barcode2: '' }                // 新增
];
const d = window.app.diffProducts(incoming, cur);
check('比對：新增 1 筆', d.added.length === 1 && d.added[0].id === 4, JSON.stringify(d.added.map(p => p.id)));
check('比對：修改 1 筆', d.changed.length === 1 && d.changed[0].after.name.includes('新包裝'), JSON.stringify(d.changed.map(c => c.after.name)));
check('比對：刪除 1 筆（Excel 已沒有）', d.removed.length === 1 && d.removed[0].id === 3, JSON.stringify(d.removed.map(p => p.id)));
check('比對：未變 1 筆', d.unchanged.length === 1 && d.unchanged[0].id === 1, String(d.unchanged.length));
check('完全相同的清單不會產生任何變更', (() => {
  const same = window.app.diffProducts(cur, cur);
  return same.added.length === 0 && same.changed.length === 0 && same.removed.length === 0;
})());

// 改名（同條碼）要沿用舊 id，不能被當成「刪除 + 新增」
const renamed = window.app.buildProductsFromRows(
  [{ 名稱: '雪碧 330ml（改名）', 條碼: '222' }],
  { nameCol: '名稱', barcodeCol: '條碼', barcode2Col: undefined },
  cur
);
check('同條碼改名 → 沿用舊 id（不會變成刪除+新增）', renamed.length === 1 && renamed[0].id === 2, JSON.stringify(renamed));
const dRenamed = window.app.diffProducts(renamed, cur);
check('改名只算「修改」，不算刪除', dRenamed.changed.length === 1 && dRenamed.added.length === 0, JSON.stringify({
  changed: dRenamed.changed.length, added: dRenamed.added.length, removed: dRenamed.removed.length
}));

// 確認視窗：有變動時顯示四種數字 + 刪除勾選
window.app.openExcelDiffModal({ fileName: '商品.xlsx', incomingCount: 3, diff: d, apply: async () => {} });
const modal = document.getElementById('excelDiffModal');
check('比對視窗會打開', modal.classList.contains('show'));
check('視窗列出新增/修改/刪除/未變數字', /新增 1/.test(document.getElementById('excelDiffCounts').textContent)
  && /修改 1/.test(document.getElementById('excelDiffCounts').textContent)
  && /刪除 1/.test(document.getElementById('excelDiffCounts').textContent)
  && /未變 1/.test(document.getElementById('excelDiffCounts').textContent),
  document.getElementById('excelDiffCounts').textContent.trim());
check('視窗顯示刪除項目與「有配對標籤」警示', /停售商品 A/.test(document.getElementById('excelDiffRows').textContent)
  && /有配對標籤/.test(document.getElementById('excelDiffRows').textContent),
  document.getElementById('excelDiffRows').textContent.slice(0, 80));
check('刪除選項預設勾選', document.getElementById('excelDiffDelete').checked === true
  && document.getElementById('excelDiffDeleteWrap').hidden === false);
check('按鈕只提「套用 N 筆變更」，不是全部重傳', /套用 2 筆變更/.test(document.getElementById('excelDiffConfirm').textContent),
  document.getElementById('excelDiffConfirm').textContent);
check('有配對標籤的刪除會標示出來', /其中 1 個有配對標籤/.test(document.getElementById('excelDiffDeleteText').textContent),
  document.getElementById('excelDiffDeleteText').textContent);

// 取消 → 完全不做任何事
let applied = null;
window.app.openExcelDiffModal({ fileName: '商品.xlsx', incomingCount: 3, diff: d, apply: async o => { applied = o; } });
document.getElementById('excelDiffCancel').dispatchEvent(new window.Event('click'));
await wait(50);
check('按取消不會套用', applied === null && !document.getElementById('excelDiffModal').classList.contains('show'));

// 確認 → 只把 deleteRemoved 傳給套用函式
window.app.openExcelDiffModal({ fileName: '商品.xlsx', incomingCount: 3, diff: d, apply: async o => { applied = o; } });
document.getElementById('excelDiffDelete').checked = false;
document.getElementById('excelDiffConfirm').dispatchEvent(new window.Event('click'));
await wait(120);
check('取消勾選時 → 保留那些商品', applied && applied.deleteRemoved === false, JSON.stringify(applied));

// 沒有差異的檔案
const sameDiff = window.app.diffProducts(cur, cur);
window.app.openExcelDiffModal({ fileName: '一樣.xlsx', incomingCount: 3, diff: sameDiff, apply: async () => {} });
check('沒有差異時不顯示刪除選項', document.getElementById('excelDiffDeleteWrap').hidden === true);
check('沒有差異時按鈕只說「知道了」', document.getElementById('excelDiffConfirm').textContent === '知道了',
  document.getElementById('excelDiffConfirm').textContent);

/* ------------------------------- 13. 備份／匯出／配對診斷 */
console.log('\n=== 13. 備份／匯出／診斷 ===');

// 準備：2 個商品、1 個已配對、1 個未配對（未配對的名稱故意接近某商品）
state.products = [
  { id: 901, name: '達利園瑞士卷草莓味 240g', barcode: '6900000000001', barcode2: '', labelId: null },
  { id: 902, name: '佳得樂檸檬味運動飲料 600ml', barcode: '6900000000002', barcode2: '', labelId: null }
];
state.labels = {
  'x-matched': makeLabel('x-matched', 'hash-x1', '達利園瑞士卷草莓味_標籤_7x4cm', {
    productId: 901, matchedProductName: '達利園瑞士卷草莓味 240g', matchSource: 'manual', uploaded: true
  }),
  'x-unmatched': makeLabel('x-unmatched', 'hash-x2', '佳得樂檸檬味運動飲料_標籤_7x4cm', { uploaded: true }),
  'x-orphan': makeLabel('x-orphan', 'hash-x3', 'Tdmigo巧克力抹茶味威化餅乾_標籤_7x4cm', { uploaded: true })
};
state.cloudEnabled = false;
state.matchIndex = null;
window.app.renderMatchList();

const downloads = [];
const originalCreate = window.URL.createObjectURL;
const originalCreateGlobal = globalThis.URL.createObjectURL;
const capture = blob => { downloads.push(blob); return 'blob:mock'; };
window.URL.createObjectURL = capture;
globalThis.URL.createObjectURL = capture;
window.URL.revokeObjectURL = () => {};
globalThis.URL.revokeObjectURL = () => {};
const anchorClicks = [];
const originalClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function () { anchorClicks.push(this.download); };

// 1) 未配對清單 CSV
const unmatchedCount = window.app.exportUnmatchedCsv();
await wait(50);
check('匯出未配對清單：筆數正確（2 筆）', unmatchedCount === 2, String(unmatchedCount));
const csvBytes = new Uint8Array(await downloads[downloads.length - 1].arrayBuffer());
check('CSV 有 UTF-8 BOM（Excel 中文不亂碼）',
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  [...csvBytes.slice(0, 3)].map(b => b.toString(16)).join(' '));
const csvText = await downloads[downloads.length - 1].text();
check('CSV 指出「佳得樂」最接近的商品', /佳得樂檸檬味運動飲料 600ml/.test(csvText),
  csvText.split('\r\n')[1] || '');
check('匯出檔案有下載動作', anchorClicks.length >= 1 && /未配對清單_/.test(anchorClicks[anchorClicks.length - 1]),
  anchorClicks[anchorClicks.length - 1] || '');

// 2) 配對診斷
const diag = window.app.exportDiagnostics();
await wait(50);
check('診斷：2 筆未配對', diag.unmatched === 2, JSON.stringify(diag));
check('診斷：無關的標籤被歸類為「找不到接近商品」', diag.noCandidate === 1, JSON.stringify(diag));
const diagText = await downloads[downloads.length - 1].text();
check('診斷報告含分數與原因', /分數|名稱相同|關鍵詞/.test(diagText), diagText.split('\r\n')[1] || '');
check('診斷報告給出可行動的判斷', /請人工確認|分數太低|商品庫可能沒有|可自動配對/.test(diagText),
  diagText.split('\r\n').slice(1).map(l => l.split(',').pop()).join(' / '));

// 3) 單一標籤診斷 API
const single = window.app.diagnoseLabel(state.labels['x-unmatched']);
check('diagnoseLabel 回傳最接近的商品', Boolean(single) && single.product.id === 902,
  single ? `${single.product.name} (${Math.round(single.score)} 分 ${single.confidence})` : 'null');
check('診斷有說明原因', Boolean(single) && single.why.length > 0, single ? single.why.join('、') : '');

// 4) JSON 備份
const backupCount = window.app.exportJsonBackup();
await wait(50);
check('JSON 備份：標籤筆數正確', backupCount === 3, String(backupCount));
const backup = JSON.parse(await downloads[downloads.length - 1].text());
check('JSON 備份含商品與標籤', backup.products.length === 2 && backup.labels.length === 3,
  `${backup.products.length} / ${backup.labels.length}`);
check('JSON 備份含配對資訊', backup.labels.some(l => l.productId === 901 && l.matchedProductName),
  JSON.stringify(backup.labels.find(l => l.id === 'x-matched') || {}));
check('JSON 備份有格式標記與版本', backup.format === 'product-label-app-backup' && backup.version === 1);

// 5) Excel 匯出（需要 XLSX）
if (window.XLSX) {
  const rows = window.app.exportExcel();
  await wait(100);
  check('Excel 匯出：每筆商品一列', rows === 2, String(rows));
  check('Excel 檔名正確', /商品配對備份_/.test(anchorClicks[anchorClicks.length - 1]),
    anchorClicks[anchorClicks.length - 1] || '');
} else {
  check('Excel 匯出（測試環境無 XLSX，略過）', true, 'skipped');
}

// 6) 工具視窗
window.app.openToolsModal();
check('工具視窗會打開', document.getElementById('toolsModal').classList.contains('show'));
check('工具視窗顯示統計', /商品 2/.test(document.getElementById('toolsStatus').textContent),
  document.getElementById('toolsStatus').textContent);
document.getElementById('toolsCloseBtn').dispatchEvent(new window.Event('click'));
check('工具視窗可關閉', !document.getElementById('toolsModal').classList.contains('show'));

window.URL.createObjectURL = originalCreate;
globalThis.URL.createObjectURL = originalCreateGlobal;
window.HTMLAnchorElement.prototype.click = originalClick;

/* ------------------------------- 14. 掃碼台（掃一下 → 直接出標籤） */
console.log('\n=== 14. 掃碼台 ===');

state.products = [
  { id: 501, name: '達利園瑞士卷草莓味 240g', barcode: '6901234567890', barcode2: '', labelId: null },
  { id: 502, name: '佳得樂檸檬味運動飲料 600ml', barcode: '6901234567892', barcode2: '', labelId: null },
  { id: 503, name: '沒有標籤的商品', barcode: '6901234567899', barcode2: '', labelId: null },
  { id: 504, name: '佳得樂檸檬味運動飲料 900ml', barcode: '6901234567893', barcode2: '', labelId: null }
];
state.labels = {
  's-1': makeLabel('s-1', 'hash-s1', '達利園瑞士卷草莓味_標籤_7x4cm', {
    productId: 501, matchedProductName: '達利園瑞士卷草莓味 240g', matchSource: 'auto', uploaded: true, ext: 'wdfx',
    filename: '達利園瑞士卷草莓味240g_標籤_7x4cm.wdfx'
  }),
  's-2': makeLabel('s-2', 'hash-s2', '佳得樂檸檬味運動飲料_標籤_7x4cm', {
    productId: 502, matchedProductName: '佳得樂檸檬味運動飲料 600ml', matchSource: 'auto', uploaded: true, ext: 'pdf'
  })
};
state.scanRecent = [];
state.cloudEnabled = false;
window.app.switchTab('scan');
await wait(60);

check('掃碼台是預設分頁', document.getElementById('panel-scan').classList.contains('active'),
  document.querySelector('.tab.active') ? document.querySelector('.tab.active').textContent : '');
check('掃碼台摘要只算「有標籤的商品」（2 支）',
  /可掃描 2 支有標籤的商品/.test(document.getElementById('scanDeskSummary').textContent),
  document.getElementById('scanDeskSummary').textContent);
check('摘要會顯示未配對數', /還有 \d+ 個標籤未配對|全部標籤已配對/.test(document.getElementById('scanDeskSummary').textContent));

// 1) 掃到有標籤的商品（完整條碼）
document.getElementById('scanDeskInput').value = '6901234567890';
window.app.scanDeskLookup();
await wait(60);
const card = document.getElementById('scanDeskCard');
check('掃到有標籤的商品 → 顯示商品名稱', /達利園瑞士卷草莓味 240g/.test(card.textContent), card.textContent.slice(0, 60));
check('顯示標籤檔名與格式', /wdfx/i.test(card.textContent) && /WDFX/i.test(card.textContent), card.textContent.slice(0, 120));
check('有「WePrint」與「預覽」「下載」三個動作', /WePrint/.test(card.textContent) && /預覽/.test(card.textContent) && /下載/.test(card.textContent));
check('掃過的會進入「最近掃過」', document.getElementById('scanDeskRecent').textContent.includes('達利園瑞士卷草莓味 240g'),
  document.getElementById('scanDeskRecent').textContent.trim());

// 2) 條碼尾 6 碼（唯一的商品）
document.getElementById('scanDeskInput').value = '567892';
window.app.scanDeskLookup();
await wait(60);
check('輸入尾 6 碼也能找到', /佳得樂檸檬味運動飲料 600ml/.test(card.textContent), card.textContent.slice(0, 60));
check('有標示是用尾 6 碼找到', /尾 6 碼/.test(card.textContent), card.textContent.slice(0, 80));

// 3) 商品存在但沒有標籤
document.getElementById('scanDeskInput').value = '6901234567899';
window.app.scanDeskLookup();
await wait(60);
check('沒有標籤的商品會變紅色警告', card.classList.contains('warn'));
check('警告寫「這支商品還沒有標籤」', /這支商品還沒有標籤/.test(card.textContent), card.textContent.slice(0, 60));
check('警告提供「上傳標籤」與「去配對管理」', /上傳標籤/.test(card.textContent) && /配對管理/.test(card.textContent));

// 4) 商品庫完全沒有這個條碼
document.getElementById('scanDeskInput').value = '9999999999999';
window.app.scanDeskLookup();
await wait(60);
check('不存在的條碼 → 明確說明', /商品庫沒有這個條碼/.test(card.textContent), card.textContent.slice(0, 60));

// 5) 範圍限制：搜尋只搜「有標籤的商品」
const hits = window.app.findLabeledProductsByName('佳得樂');
check('名稱搜尋只在有標籤的 2 支裡找（不含 900ml）', hits.length === 1 && hits[0].id === 502,
  hits.map(p => p.id).join(','));
const noLabelHits = window.app.findLabeledProductsByName('沒有標籤的商品');
check('沒有標籤的商品不會出現在掃碼台搜尋結果', noLabelHits.length === 0, String(noLabelHits.length));

// 6) 動作：上傳 → 切到上傳分頁；配對 → 切到配對管理
card.querySelector('[data-scan-action="upload"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(60);
check('按「上傳標籤」會切到上傳分頁', document.getElementById('panel-upload').classList.contains('active'));
document.getElementById('scanDeskInput').value = '6901234567899';
window.app.scanDeskLookup();
await wait(60);
card.querySelector('[data-scan-action="match"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(60);
check('按「去配對管理」會切到配對管理並篩選未配對', document.getElementById('panel-match').classList.contains('active'));

// 7) 重複掃同一支不會在「最近掃過」重複
window.app.switchTab('scan');
await wait(40);
document.getElementById('scanDeskInput').value = '6901234567890';
window.app.scanDeskLookup();
await wait(60);
const recentRows = [...document.querySelectorAll('#scanDeskRecent [data-scan-recent]')];
check('最近掃過不會重複同一支商品', recentRows.filter(r => r.dataset.scanRecent === '501').length === 1,
  recentRows.map(r => r.dataset.scanRecent).join(','));
check('最近掃過最多 12 筆', recentRows.length <= 12, String(recentRows.length));

// 8) 按「最近掃過」可以立刻回到那支商品
recentRows.find(r => r.dataset.scanRecent === '502').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(60);
check('按最近掃過會顯示該商品標籤', /佳得樂檸檬味運動飲料 600ml/.test(card.textContent), card.textContent.slice(0, 60));

// 9) 分頁順序：掃碼台在最前
const tabLabels = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
check('分頁順序：掃碼台 → 搜尋 → 配對管理 → 上傳',
  tabLabels[0].includes('掃碼台') && tabLabels[1].includes('搜尋') && tabLabels[2].includes('配對管理') && tabLabels[3].includes('上傳'),
  tabLabels.join(' | '));

/* ---------------- 15. 檔案類型與 WePrint 分享（.wdfx 不可以變成 PDF） */
console.log('\n=== 15. 檔案類型與 WePrint 分享 ===');

check('.wdfx 即使 mime 寫錯也要當成 octet-stream',
  window.app.labelMime({ filename: 'a.wdfx', mime: 'application/pdf' }) === 'application/octet-stream',
  window.app.labelMime({ filename: 'a.wdfx', mime: 'application/pdf' }));
check('.pdf 才是 application/pdf',
  window.app.labelMime({ filename: 'a.pdf', mime: 'application/octet-stream' }) === 'application/pdf');
check('沒有副檔名時用 ext 欄位',
  window.app.labelMime({ filename: 'x', ext: 'wdfx' }) === 'application/octet-stream');
check('檔名會保留副檔名', window.app.fileNameFor({ filename: 'b.wdfx' }) === 'b.wdfx'
  && window.app.fileNameFor({ filename: 'c', ext: 'wdfx' }) === 'c.wdfx',
  `${window.app.fileNameFor({ filename: 'b.wdfx' })} / ${window.app.fileNameFor({ filename: 'c', ext: 'wdfx' })}`);

const fileObj = window.app.asFile(new window.Blob(['x']), 'd.wdfx');
check('包成 File 時類型不是 PDF', fileObj.type === 'application/octet-stream', fileObj.type);

// 同一商品同時有 PDF 與 .wdfx → 掃碼台要選 .wdfx
state.products = [{ id: 601, name: '莫小希沙琪瑪 南瓜籽', barcode: '6932965112211', barcode2: '', labelId: null }];
state.labels = {
  'p-pdf': makeLabel('p-pdf', 'hash-p1', '莫小希沙琪瑪南瓜籽', {
    productId: 601, matchedProductName: '莫小希沙琪瑪 南瓜籽', uploaded: true, ext: 'pdf',
    filename: '莫小希沙琪瑪南瓜籽_標籤_7x4cm.pdf', uploadedAt: '2026-11-20T00:00:00Z'
  }),
  'p-wdfx': makeLabel('p-wdfx', 'hash-p2', '莫小希沙琪瑪南瓜籽', {
    productId: 601, matchedProductName: '莫小希沙琪瑪 南瓜籽', uploaded: true, ext: 'wdfx',
    filename: '莫小希沙琪瑪南瓜籽_標籤_7x4cm.wdfx', uploadedAt: '2026-11-19T00:00:00Z'
  })
};
const chosen = window.app.labelForProduct(601);
check('同一商品有 PDF 與 .wdfx → 優先 .wdfx', chosen && chosen.id === 'p-wdfx',
  chosen ? chosen.filename : 'null');

// 掃碼台顯示的卡片要用 .wdfx
window.app.switchTab('scan');
document.getElementById('scanDeskInput').value = '6932965112211';
window.app.scanDeskLookup();
await wait(120);
const scanCard = document.getElementById('scanDeskCard');
check('掃碼台顯示 .wdfx 而不是 PDF', /wdfx/i.test(scanCard.textContent) && !/\.pdf/i.test(scanCard.textContent),
  scanCard.textContent.replace(/\s+/g, ' ').slice(0, 90));

// 分享：用已預抓的 blob，檔名要保留 .wdfx
const shared = [];
Object.defineProperty(window.navigator, 'share', {
  value: async payload => { shared.push(payload); }, configurable: true
});
Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
Object.defineProperty(globalThis.navigator, 'share', { value: window.navigator.share, configurable: true });
Object.defineProperty(globalThis.navigator, 'canShare', { value: window.navigator.canShare, configurable: true });

state.blobCache.set('p-wdfx', new window.Blob(['WD F X'], { type: 'application/octet-stream' }));
await window.app.shareLabel('p-wdfx');
await wait(80);
check('分享會打開系統分享選單', shared.length === 1, `呼叫 ${shared.length} 次`);
const sharedFile = shared[0] && shared[0].files && shared[0].files[0];
check('分享的檔名是 .wdfx', Boolean(sharedFile) && /\.wdfx$/.test(sharedFile.name), sharedFile && sharedFile.name);
check('分享的類型不是 application/pdf', Boolean(sharedFile) && sharedFile.type === 'application/octet-stream',
  sharedFile && sharedFile.type);

// 沒有分享 API 時 → 下載（檔名仍要是 .wdfx）
Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true });
Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
const downloads2 = [];
const originalCreate2 = globalThis.URL.createObjectURL;
globalThis.URL.createObjectURL = () => 'blob:mock';
const clickNames = [];
const originalClick2 = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function () { clickNames.push(this.download); };
window.app.fallbackDownload(window.app.asFile(new window.Blob(['x']), 'e.wdfx'));
await wait(60);
check('不支援分享時改為下載，檔名仍是 .wdfx',
  clickNames.length === 1 && /\.wdfx$/.test(clickNames[0]), clickNames.join(','));
check('下載提示會說明如何用微打開啟',
  /微打|WePrint/.test(document.getElementById('toast').textContent),
  document.getElementById('toast').textContent);
window.HTMLAnchorElement.prototype.click = originalClick2;
globalThis.URL.createObjectURL = originalCreate2;

/* --------------------------------------------------------- 結果 */
const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) {
  console.log('失敗：', failed.map(f => `${f.name}（${f.detail}）`).join(' | '));
  process.exitCode = 1;
}
