/*
 * 瀏覽器層級整合測試（JSDOM）
 *
 * 目的：不需要真的手機，也能驗證
 *   - index.html 的 DOM id 與 app.js 完全對得上（沒有 null.addEventListener）
 *   - 選取 174 個 PDF 後，UI 立即顯示總數、每列狀態會更新
 *   - IndexedDB 真的寫入 174 個 metadata + 174 個 blob
 *   - 沒有 Service Worker 的情況下也能正常運作
 *   - Excel 匯入後自動重新配對
 *
 * 執行：node tools/ui-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { makeCatalog, makePdfFiles } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const html = readFileSync(join(root, 'index.html'), 'utf8');

// 1) 靜態檢查：app.js 用到的每個 id 都存在於 index.html
const appSource = readFileSync(join(root, 'js/app.js'), 'utf8');
const usedIds = new Set([...appSource.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
const domIds = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const missing = [...usedIds].filter(id => !domIds.has(id));

console.log('=== UI 靜態檢查 ===');
console.log(`  app.js 使用的元素 id: ${usedIds.size}`);
console.log(`  index.html 提供的 id: ${domIds.size}`);
console.log(`  缺少的 id: ${missing.length ? missing.join(', ') : '(無)'}`);

if (missing.length) {
  console.error('找不到元素，app.js 會在啟動時拋錯');
  process.exit(1);
}

// 2) 建立 JSDOM 環境
const dom = new JSDOM(html, {
  url: 'https://product-label-app.pages.dev/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
Object.defineProperty(globalThis.navigator, 'storage', {
  value: {
    estimate: async () => ({ quota: 4 * 1024 * 1024 * 1024, usage: 50 * 1024 * 1024 }),
    persist: async () => true
  },
  configurable: true
});
Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Worker = undefined; // 模擬沒有 Worker 的環境，驗證主執行緒備援路徑
globalThis.fetch = async () => {
  throw new Error('離線測試環境');
};

// index.html 用 <script src> 提供這些全域變數，JSDOM 不會執行它們，這裡手動補上
const xlsxModule = await import(join(root, 'vendor/xlsx.full.min.js'));
globalThis.XLSX = xlsxModule.default || globalThis.XLSX;
window.XLSX = globalThis.XLSX;
console.log('  XLSX 全域可用:', Boolean(globalThis.XLSX));

console.log('\n=== 載入 app.js ===');
const app = await import('../js/app.js');
await new Promise(r => setTimeout(r, 120));
console.log('  boot 完成（window.app 已建立）:', Boolean(window.app));

const db = await import('../js/store/db.js');
const { buildIndex, matchFileName } = await import('../js/core/matcher.js');

// 3) 匯入 Excel（用 XLSX 直接產生，模擬使用者上傳）
console.log('\n=== 模擬上傳 Excel（3,000 商品）===');
const XLSX = globalThis.XLSX;
const catalog = makeCatalog(3000);
const sheetRows = catalog.map(p => ({ 名稱: p.name, 條碼: p.barcode, 第二條碼: p.barcode2 }));
const ws = XLSX.utils.json_to_sheet(sheetRows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '商品');
const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
const excelFile = new File([xlsxBuffer], 'products.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

const excelInput = document.getElementById('excelInput');
Object.defineProperty(excelInput, 'files', { value: [excelFile], configurable: true });
excelInput.dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 1500));

// 匯入 Excel 現在會先跳「比對結果」視窗，確認後才套用
const diffModal = document.getElementById('excelDiffModal');
console.log('  比對視窗:', diffModal.classList.contains('show') ? '已顯示' : '未顯示',
  '|', document.getElementById('excelDiffCounts').textContent.replace(/\s+/g, ' ').trim());
if (diffModal.classList.contains('show')) {
  document.getElementById('excelDiffConfirm').dispatchEvent(new window.Event('click'));
  await new Promise(r => setTimeout(r, 2000));
}
console.log('  比對視窗關閉:', !diffModal.classList.contains('show'));
console.log('  excelStatus:', document.getElementById('excelStatus').textContent);
console.log('  statProducts:', document.getElementById('statProducts').textContent);
const storedProducts = await db.getProducts();
console.log('  IndexedDB 商品數:', storedProducts.length);

// 4) 匯入 174 個 PDF
console.log('\n=== 模擬選取 174 個 PDF ===');
const files = makePdfFiles(catalog, 174, { seed: 9090, minSize: 20 * 1024, maxSize: 120 * 1024 });
const pdfInput = document.getElementById('pdfInput');
Object.defineProperty(pdfInput, 'files', { value: files, configurable: true });

const started = Date.now();
pdfInput.dispatchEvent(new window.Event('change'));

await new Promise(r => setTimeout(r, 20));
const immediateStatus = document.getElementById('pdfStatus').textContent;
const immediateCounts = document.getElementById('jobCounts').textContent;

// 等到全部離開 pending
let waited = 0;
while (waited < 120000) {
  const statuses = [...document.querySelectorAll('#jobList .job-row')].map(r => r.dataset.status);
  if (statuses.length >= 170 && statuses.every(s => ['ready', 'done', 'duplicate', 'failed'].includes(s))) break;
  await new Promise(r => setTimeout(r, 100));
  waited += 100;
}
const elapsed = Date.now() - started;

const rows = [...document.querySelectorAll('#jobList .job-row')];
const statusCounts = rows.reduce((acc, row) => {
  acc[row.dataset.status] = (acc[row.dataset.status] || 0) + 1;
  return acc;
}, {});

console.log('  立即顯示的總數:', immediateCounts);
console.log('  立即顯示的狀態:', immediateStatus);
console.log('  job rows:', rows.length, JSON.stringify(statusCounts));
console.log('  pdfStatus:', document.getElementById('pdfStatus').textContent);
const failedJobs = window.app.pipeline.getJobs().filter(j => j.status === 'failed');
if (failedJobs.length) console.log('  失敗原因:', failedJobs.map(j => `${j.name}: ${j.error}`).join(' | '));
console.log('  耗時:', `${elapsed}ms`);

const labels = await db.getLabels();
const productsAfter = await db.getProducts();
const labelList = Object.values(labels);
const matched = labelList.filter(l => l.matchedProductName).length;
const blobs = await db.blobBytes();
console.log('\n=== 結果 ===');
console.log('  IndexedDB 標籤數:', labelList.length);
console.log('  已配對:', matched);
console.log('  Blob 數 / 大小:', blobs.count, `${(blobs.bytes / 1024 / 1024).toFixed(1)}MB`);
console.log('  商品 labelId 連結數:', productsAfter.filter(p => p.labelId).length);
console.log('  statLabels / statMatched:', document.getElementById('statLabels').textContent, '/', document.getElementById('statMatched').textContent);


// 5) 搜尋（條碼尾 6 碼）＋ 配對管理頁渲染
console.log('\n=== 搜尋與配對管理 ===');
const firstProduct = productsAfter.find(p => p.labelId);
const tail = firstProduct.barcode.slice(-6);
document.getElementById('barcodeInput').value = tail;
document.getElementById('searchBtn').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 300));
const resultHtml = document.getElementById('searchResults').innerHTML;
console.log(`  條碼尾 6 碼 ${tail} 搜尋結果含商品:`, resultHtml.includes(firstProduct.name));

document.querySelector('.tab[data-tab="match"]').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 100));
console.log('  matchSummary:', document.getElementById('matchSummary').textContent);

// 6) 重新選同一批 → 全部略過
console.log('\n=== 重新選取同一批 174 個 PDF ===');
const pdfInput2 = document.getElementById('pdfInput');
Object.defineProperty(pdfInput2, 'files', { value: files, configurable: true });
pdfInput2.dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 3000));
const labelsAfter = await db.getLabels();
const blobsAfter = await db.blobBytes();
console.log('  標籤數（應維持 174）:', Object.keys(labelsAfter).length);
console.log('  Blob 數（應維持 174）:', blobsAfter.count);
console.log('  狀態:', document.getElementById('pdfStatus').textContent);

// 7) 判定
const pass =
  missing.length === 0 &&
  storedProducts.length === 3000 &&
  labelList.length === 174 &&
  blobs.count === 174 &&
  Object.keys(labelsAfter).length === 174 &&
  blobsAfter.count === 174 &&
  matched > 120 &&
  document.getElementById('statMatched').textContent === String(matched);

console.log('\n=== 判定 ===');
console.log(pass ? '  ✅ 全部通過' : '  ❌ 有項目未通過');
await db.deleteDatabase();
process.exit(pass ? 0 : 1);
