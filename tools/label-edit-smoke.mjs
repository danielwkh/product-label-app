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
check('每組筆數正確（3 與 2）', dupMap.get('dupA-1') === 3 && dupMap.get('dupB-1') === 2,
  `${dupMap.get('dupA-1')} / ${dupMap.get('dupB-1')}`);
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
check('剩下 dupA-2 與 single-1', Object.keys(state.labels).sort().join(',') === 'dupA-2,single-1', Object.keys(state.labels).join(','));
check('本機只剩下 2 個 Blob', (await db.blobBytes()).count === 2, `${(await db.blobBytes()).count}`);

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

/* --------------------------------------------------------- 結果 */
const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) {
  console.log('失敗：', failed.map(f => `${f.name}（${f.detail}）`).join(' | '));
  process.exitCode = 1;
}
