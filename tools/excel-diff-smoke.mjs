/*
 * Excel 增量匯入（先比對再只送變更）的端到端測試
 *
 * 驗證：
 *   1. 真的 .xlsx 檔 → 解析 → 比對 → 顯示確認視窗（新增/修改/刪除/未變）
 *   2. 取消 = 完全不做任何事
 *   3. 套用 = 只寫有變動的幾筆（不是整份 2 萬多筆）
 *   4. 刪除的商品：勾選才刪、取消勾選則保留
 *   5. 被刪商品上的標籤會變成未配對，但標籤檔案本身不會被刪
 *
 * 執行：node tools/excel-diff-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import * as XLSX from 'xlsx';

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
window.confirm = () => true;
globalThis.confirm = () => true;
window.alert = () => {};
// 網站用 CDN 載入 SheetJS，測試時直接注入
window.XLSX = XLSX.default || XLSX;
globalThis.XLSX = window.XLSX;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

const app = await import('../js/app.js');
await wait(150);
const db = await import('../js/store/db.js');
const state = window.app.state;

const now = new Date().toISOString();
const makeLabel = (id, name, extra = {}) => ({
  id, filename: `${name}.pdf`, nameFromFile: name, hash: `hash-${id}`, size: 1024,
  productId: null, matchedProductName: null, matchSource: null,
  uploadedAt: now, updatedAt: now, uploaded: false, hasLocalBlob: true, ...extra
});

/* ---------------------------------------------------- 準備舊資料 */
console.log('=== 準備：雲端已有的 3 個商品 + 1 個配對標籤 ===');
const oldProducts = [
  { id: 1, name: '可樂 330ml', barcode: '111', barcode2: '', labelId: null },
  { id: 2, name: '雪碧 330ml', barcode: '222', barcode2: '', labelId: 'L-2' },
  { id: 3, name: '停售商品 A', barcode: '333', barcode2: '', labelId: null }
];
state.products = oldProducts.map(p => ({ ...p }));
state.cloudEnabled = false;
await db.replaceProducts(state.products);

const matchedLabel = makeLabel('L-2', '雪碧標籤', {
  productId: 2, matchedProductName: '雪碧 330ml', matchSource: 'manual', matchConfidence: 'manual'
});
state.labels = { 'L-2': { ...matchedLabel } };
await db.putLabel(matchedLabel);
console.log(`  商品 ${state.products.length} 個、標籤 ${Object.keys(state.labels).length} 個`);

const makeXlsx = rows => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '商品');
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return { name: '商品清單.xlsx', arrayBuffer: async () => buffer };
};

/* ------------------------------------- 1. 比對結果（不直接寫入） */
console.log('\n=== 1. 上傳 Excel：先比對，不寫入 ===');
const nextRows = [
  { 名稱: '可樂 330ml', 條碼: '111', 第二條碼: '' },          // 未變
  { 名稱: '雪碧 330ml（新包裝）', 條碼: '222', 第二條碼: '' }, // 同條碼改名 → 修改
  { 名稱: '新商品 B', 條碼: '444', 第二條碼: '' }              // 新增
  // 「停售商品 A」不在新檔案 → 刪除
];
await window.app.importExcel(makeXlsx(nextRows));
await wait(200);

const modal = document.getElementById('excelDiffModal');
check('上傳後會跳出比對視窗', modal.classList.contains('show'));
const countsText = document.getElementById('excelDiffCounts').textContent.replace(/\s+/g, ' ');
check('比對數字正確：新增 1 / 修改 1 / 刪除 1 / 未變 1',
  /新增 1/.test(countsText) && /修改 1/.test(countsText) && /刪除 1/.test(countsText) && /未變 1/.test(countsText),
  countsText.trim());
check('還沒按套用 → 本機商品完全沒變',
  state.products.length === 3 && state.products.find(p => p.id === 2).name === '雪碧 330ml',
  `${state.products.length} 個、id2=${state.products.find(p => p.id === 2).name}`);
const dbBefore = await db.getProducts();
check('IndexedDB 也還沒被改', dbBefore.length === 3 && dbBefore.find(p => p.id === 2).name === '雪碧 330ml',
  `${dbBefore.length} 筆`);

/* --------------------------------------------- 2. 取消 → 什麼都不做 */
console.log('\n=== 2. 按取消 ===');
document.getElementById('excelDiffCancel').dispatchEvent(new window.Event('click'));
await wait(100);
check('取消後視窗關閉', !modal.classList.contains('show'));
check('取消後商品仍是 3 個', state.products.length === 3, `${state.products.length}`);
check('取消後 IndexedDB 仍是 3 筆', (await db.getProducts()).length === 3);

/* ------------------------------------------- 3. 套用（含刪除勾選） */
console.log('\n=== 3. 套用變更（含刪除） ===');
await window.app.importExcel(makeXlsx(nextRows));
await wait(200);
document.getElementById('excelDiffConfirm').dispatchEvent(new window.Event('click'));
await wait(1200);

check('新增的商品進來了（id=4）', Boolean(state.products.find(p => p.name === '新商品 B')),
  state.products.map(p => p.name).join(' | '));
check('改名的商品沿用舊 id（沒有變成刪除+新增）',
  Boolean(state.products.find(p => p.id === 2 && p.name === '雪碧 330ml（新包裝）')),
  state.products.filter(p => p.id === 2).map(p => p.name).join(','));
check('Excel 已沒有的商品被刪掉（3 個 → 3 個）', !state.products.find(p => p.id === 3),
  state.products.map(p => p.id).join(','));
check('商品總數 = 3（2 舊 + 1 新，停售的移除）', state.products.length === 3, `${state.products.length}`);
const dbAfter = await db.getProducts();
check('IndexedDB 同步：停售商品不在了', !dbAfter.find(p => p.id === 3), dbAfter.map(p => p.id).join(','));
check('IndexedDB 同步：新商品在', Boolean(dbAfter.find(p => p.name === '新商品 B')));
check('商品名稱已更新為新包裝', dbAfter.find(p => p.id === 2).name === '雪碧 330ml（新包裝）',
  dbAfter.find(p => p.id === 2).name);
check('改名沒有把配對洗掉', state.labels['L-2'].matchedProductName === '雪碧 330ml（新包裝）'
  || state.labels['L-2'].productId === 2, JSON.stringify({ pid: state.labels['L-2'].productId, name: state.labels['L-2'].matchedProductName }));

/* --------------------------- 4. 被刪商品上的標籤 → 未配對但檔案還在 */
console.log('\n=== 4. 刪掉的商品上有標籤 ===');
const delRows = [
  { 名稱: '可樂 330ml', 條碼: '111', 第二條碼: '' },
  { 名稱: '新商品 B', 條碼: '444', 第二條碼: '' }
];
await window.app.importExcel(makeXlsx(delRows));
await wait(200);
check('有配對標籤的刪除會提示（雪碧有配對）',
  /有配對標籤/.test(document.getElementById('excelDiffRows').textContent),
  document.getElementById('excelDiffRows').textContent.slice(0, 120));
document.getElementById('excelDiffConfirm').dispatchEvent(new window.Event('click'));
await wait(1200);
check('被刪商品的標籤變成未配對', state.labels['L-2'].productId === null
  && state.labels['L-2'].matchedProductName === null, JSON.stringify(state.labels['L-2']));
check('標籤檔案本身沒有被刪（還在清單裡）', Boolean(state.labels['L-2']));
check('本機標籤記錄也同步（IndexedDB）', (await db.getLabel('L-2')).productId === null);

/* --------------------------------- 5. 取消勾選刪除 → 商品保留 */
console.log('\n=== 5. 取消勾選「刪除」 ===');
state.products = [
  { id: 1, name: '可樂 330ml', barcode: '111', barcode2: '', labelId: null },
  { id: 2, name: '雪碧 330ml', barcode: '222', barcode2: '', labelId: null }
];
await db.replaceProducts(state.products);
await window.app.importExcel(makeXlsx([{ 名稱: '可樂 330ml', 條碼: '111', 第二條碼: '' }]));
await wait(200);
document.getElementById('excelDiffDelete').checked = false;
document.getElementById('excelDiffConfirm').dispatchEvent(new window.Event('click'));
await wait(800);
check('取消勾選後，Excel 沒有的商品仍保留在清單', state.products.length === 2, state.products.map(p => p.name).join(' | '));
check('本機檔案也保留', (await db.getProducts()).length === 2);

/* ----------------------------------- 6. 完全沒變的檔案 */
console.log('\n=== 6. 一模一樣的 Excel ===');
const sameRows = state.products.map(p => ({ 名稱: p.name, 條碼: p.barcode, 第二條碼: '' }));
await window.app.importExcel(makeXlsx(sameRows));
await wait(200);
const sameCounts = document.getElementById('excelDiffCounts').textContent.replace(/\s+/g, ' ');
check('沒有變動時四個數字都是 0 / 未變 2',
  /新增 0/.test(sameCounts) && /修改 0/.test(sameCounts) && /刪除 0/.test(sameCounts),
  sameCounts.trim());
check('沒有變動時不顯示刪除勾選', document.getElementById('excelDiffDeleteWrap').hidden === true);
check('沒有變動時按鈕寫「知道了」', document.getElementById('excelDiffConfirm').textContent === '知道了',
  document.getElementById('excelDiffConfirm').textContent);

/* --------------------------------------------------------- 結果 */
const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) {
  console.log('失敗：', failed.map(f => `${f.name}（${f.detail}）`).join(' | '));
  process.exitCode = 1;
}
