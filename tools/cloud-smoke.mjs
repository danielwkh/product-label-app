/*
 * 雲端連線迴歸測試（重現「雲端 API 尚未啟用」誤報）
 *
 * 用生產規模的資料（22,481 個商品、2 個標籤）模擬 bootstrap，驗證：
 *   1. 連線成功後 cloudStatus 必須顯示「已連線雲端」
 *   2. 使用者在 bootstrap 完成前就按「同步」→ 不可以誤報「尚未啟用」，要等連線後繼續
 *   3. 本機離線快取寫入失敗 → 雲端狀態仍是已連線（只顯示警告）
 *   4. 「同步」只送有變動的商品（22,481 筆不會每次全送）
 *   5. 商品寫入是分塊 transaction，不會一次寫 2 萬多筆
 *
 * 執行：node tools/cloud-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { makeCatalog } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
const ok = msg => console.log(`  ✅ ${msg}`);
const bad = msg => { failures++; console.log(`  ❌ ${msg}`); };
const check = (name, condition, detail = '') => (condition ? ok(name) : bad(`${name}${detail ? ` — ${detail}` : ''}`));

/* ------------------------------------------------------ 模擬生產環境 API */

const catalog = makeCatalog(22481);
const remoteProducts = catalog.map(p => ({
  id: p.id, name: p.name, barcode: p.barcode, barcode2: p.barcode2, labelId: null, updatedAt: '2026-11-19T14:35:31.332Z'
}));
const remoteLabels = [
  {
    id: 'label_1795098969295_yupd7a', filename: 'tes_1.pdf', nameFromFile: '測試_1',
    productId: null, matchedProductName: null, matchSource: null, matchScore: null,
    matchConfidence: null, matchGap: null, matchWhy: null, hash: null, size: 0,
    uploadedAt: '2026-11-19T14:36:09.295Z', updatedAt: '2026-11-19T14:36:10.516Z'
  },
  {
    id: 'label_1795098969296_abcd12', filename: '測試_2.pdf', nameFromFile: '測試_2',
    productId: null, matchedProductName: null, matchSource: null, matchScore: null,
    matchConfidence: null, matchGap: null, matchWhy: null, hash: null, size: 0,
    uploadedAt: '2026-11-19T14:36:10.295Z', updatedAt: '2026-11-19T14:36:11.516Z'
  }
];

const calls = { bootstrap: 0, productsBulk: 0, productsBulkRows: 0, labelsSync: 0, labelsUpload: 0 };
let bootstrapDelay = 0;
let failBootstrap = false;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
  await new Promise(r => setTimeout(r, 5));

  if (target.includes('/api/bootstrap')) {
    calls.bootstrap++;
    if (bootstrapDelay) await new Promise(r => setTimeout(r, bootstrapDelay));
    if (failBootstrap) return json({ error: 'D1 binding DB is not configured' }, 503);
    return json({ products: remoteProducts, labels: remoteLabels, cloud: true, version: 2 });
  }
  if (target.includes('/api/products/bulk')) {
    calls.productsBulk++;
    const body = JSON.parse(options.body || '{}');
    calls.productsBulkRows += (body.products || []).length;
    return json({ ok: true, count: (body.products || []).length, mode: body.mode || 'merge' });
  }
  if (target.includes('/api/labels/sync')) {
    calls.labelsSync++;
    return json({ ok: true, count: 1 });
  }
  if (target.match(/\/api\/labels$/) && options.method === 'POST') {
    calls.labelsUpload++;
    return json({ ok: true, id: 'x', deduped: false });
  }
  return json({ error: 'not found' }, 404);
};

/* ----------------------------------------------------------- JSDOM 環境 */

const html = readFileSync(join(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://product-label-app.pages.dev/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
Object.defineProperty(globalThis.navigator, 'storage', {
  value: { estimate: async () => ({ quota: 4 * 1024 * 1024 * 1024, usage: 10 * 1024 * 1024 }), persist: async () => true },
  configurable: true
});
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Worker = undefined;

const statusText = () => document.getElementById('cloudStatus').textContent;

/* ------------------------------------------- 情境 1：正常載入（含搶先按同步） */

console.log('\n=== 情境 1：bootstrap 較慢，使用者在完成前就按「同步目前資料到雲端」 ===');
bootstrapDelay = 400;
const app = await import('../js/app.js');
const db = await import('../js/store/db.js');

// bootstrap 還沒回來就按下去（模擬使用者一開頁就點）
document.getElementById('syncCloudBtn').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 120));
const early = statusText();
check('按下同步的當下不會誤報「尚未啟用」', !/尚未啟用/.test(early), early);

await new Promise(r => setTimeout(r, 2500));
const finalStatus = statusText();
check('最後狀態顯示已連線／同步完成', /已連線雲端|同步完成/.test(finalStatus), finalStatus);
check('沒有出現「雲端 API 尚未啟用」', !/尚未啟用/.test(finalStatus), finalStatus);
check('state.cloudEnabled = true', window.app.state.cloudEnabled === true);
check('商品已載入記憶體 22,481 筆', window.app.state.products.length === 22481, String(window.app.state.products.length));

const stored = await db.countProducts();
check('本機 IndexedDB 商品數 = 22,481（分塊寫入）', stored === 22481, String(stored));
const signature = await db.getMeta('productsSignature');
check('已記下商品快照簽章（下次啟動可跳過重寫）', Boolean(signature), String(signature));

/* --------------------------------------------- 情境 2：同步只送有變動的商品 */

console.log('\n=== 情境 2：按「同步」只送有變動的商品 ===');
calls.productsBulk = 0;
calls.productsBulkRows = 0;
document.getElementById('syncCloudBtn').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 800));
check('沒有變動時不送任何商品', calls.productsBulk === 0, `productsBulk=${calls.productsBulk}`);
check('狀態說明「已是最新」', /已是最新/.test(statusText()), statusText());

window.app.state.products[10].name = `${window.app.state.products[10].name} 改`;
calls.productsBulk = 0;
calls.productsBulkRows = 0;
document.getElementById('syncCloudBtn').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 800));
check('改 1 筆商品只送 1 筆', calls.productsBulkRows === 1, `送了 ${calls.productsBulkRows} 筆`);

/* ------------------------------------ 情境 3：本機快取寫入失敗不可影響雲端狀態 */

console.log('\n=== 情境 3：本機離線快取寫入失敗 ===');
await db.setMeta('productsSignature', 'stale-on-purpose');   // 強制重新寫入本機快取
window.app.state.localSnapshotWriter = () => { throw new Error('模擬 IndexedDB 逾時（60s）'); };
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 300));
check('雲端仍被判為已連線', window.app.state.cloudEnabled === true);
check('狀態仍含「已連線雲端」', /已連線雲端/.test(statusText()), statusText());
check('同時告知本機快取失敗', /本機快取寫入失敗/.test(statusText()), statusText());
window.app.state.localSnapshotWriter = null;

calls.productsBulk = 0;
calls.productsBulkRows = 0;
document.getElementById('syncCloudBtn').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 800));
check('此時按同步仍可運作（不再誤報未啟用）', !/尚未啟用/.test(statusText()), statusText());
check('同步不會把 22,481 筆全部重送', calls.productsBulkRows <= 1, `送了 ${calls.productsBulkRows} 筆`);

/* ------------------------------------------ 情境 4：真的連不上時訊息要正確 */

console.log('\n=== 情境 4：API 真的不可用時 ===');
failBootstrap = true;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 300));
check('回報「無法連線雲端」並附原因', /無法連線雲端/.test(statusText()) && /D1 binding/.test(statusText()), statusText());
check('state.cloudEnabled = false', window.app.state.cloudEnabled === false);
failBootstrap = false;

console.log(`\n=== 結果：${failures === 0 ? '全部通過' : `${failures} 項失敗`} ===`);
await db.deleteDatabase();
process.exit(failures ? 1 : 0);
