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

const calls = { bootstrap: 0, meta: 0, labelList: 0, productsBulk: 0, productsBulkRows: 0, labelsSync: 0, labelsUpload: 0, bulkDelete: 0, singleDelete: 0 };
let failDelete = false;
let failPatch = false;
let lastSyncRows = [];
let cloudLabels = remoteLabels.map(l => ({ ...l }));
let productsRevision = '1';
let labelsRevision = '1';
let bootstrapDelay = 0;
let failBootstrap = false;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
  await new Promise(r => setTimeout(r, 5));

  if (target.includes('/api/meta')) {
    calls.meta++;
    if (failBootstrap) return json({ error: 'D1_ERROR: exceeded free tier' }, 500);
    return json({ cloud: true, productsRevision, labelsRevision, revision: `${productsRevision}.${labelsRevision}` });
  }
  if (target.includes('/api/labels') && (!options.method || options.method === 'GET')) {
    calls.labelList++;
    if (failBootstrap) return json({ error: 'D1_ERROR: exceeded free tier' }, 500);
    return json({ labels: cloudLabels, cloud: true });
  }
  if (target.includes('/api/labels/bulk-delete')) {
    calls.bulkDelete++;
    if (failDelete) return json({ error: 'D1_ERROR: Your account has exceeded D1 free tier' }, 500);
    const ids = (JSON.parse(options.body || '{}').ids) || [];
    cloudLabels = cloudLabels.filter(l => !ids.includes(l.id));
    labelsRevision = String(Number(labelsRevision) + 1);
    return json({ ok: true, deleted: ids.length, ids });
  }
  if (/\/api\/labels\/[^/]+$/.test(target) && options.method === 'DELETE') {
    calls.singleDelete++;
    if (failDelete) return json({ error: 'D1_ERROR: Your account has exceeded D1 free tier' }, 500);
    const id = decodeURIComponent(target.split('/api/labels/')[1]);
    cloudLabels = cloudLabels.filter(l => l.id !== id);
    labelsRevision = String(Number(labelsRevision) + 1);
    return json({ ok: true, deleted: 1, ids: [id] });
  }
  if (target.includes('/api/bootstrap')) {
    calls.bootstrap++;
    if (bootstrapDelay) await new Promise(r => setTimeout(r, bootstrapDelay));
    if (failBootstrap) return json({ error: 'D1 binding DB is not configured' }, 503);
    return json({
      products: remoteProducts, labels: cloudLabels, cloud: true, version: 2,
      revision: `${productsRevision}.${labelsRevision}`, productsRevision, labelsRevision
    });
  }
  if (target.includes('/api/products/bulk')) {
    calls.productsBulk++;
    const body = JSON.parse(options.body || '{}');
    calls.productsBulkRows += (body.products || []).length;
    return json({ ok: true, count: (body.products || []).length, mode: body.mode || 'merge' });
  }
  if (target.includes('/api/labels/sync')) {
    calls.labelsSync++;
    const body = JSON.parse(options.body || '{}');
    lastSyncRows = body.labels || [];
    if (failPatch) return json({ error: 'D1_ERROR: exceeded free tier' }, 500);
    return json({ ok: true, count: lastSyncRows.length });
  }
  if (/\/api\/labels\/[^/]+$/.test(target) && options.method === 'PATCH') {
    calls.patch = (calls.patch || 0) + 1;
    if (failPatch) return json({ error: 'D1_ERROR: exceeded free tier' }, 500);
    return json({ ok: true, id: 'x' });
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

/* --------------------------------- 情境 1b：再次開頁不應重抓 22,481 列商品 */

console.log('\n=== 情境 1b：revision 沒變時，重開頁面不抓全量商品 ===');
const bootstrapBefore = calls.bootstrap;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 400));
check('沒有再呼叫 bootstrap（0 次全表讀取）', calls.bootstrap === bootstrapBefore, `bootstrap=${calls.bootstrap - bootstrapBefore}`);
check('只呼叫便宜的 /api/meta（2 列）', calls.meta > 0 && calls.labelList === 0,
  `meta ${calls.meta} 次、labels ${calls.labelList} 次（版本沒變就不用抓）`);
check('狀態顯示已連線（使用本機快取）', /已連線雲端/.test(statusText()), statusText());

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
productsRevision = '3';                                      // 商品版本有變 → 走完整 bootstrap，才會寫本機快取
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

/* --------------------------------------- 情境 3b：revision 變了才重抓全量 */

console.log('\n=== 情境 3b：雲端商品有變動時才重抓 ===');
productsRevision = '2';
labelsRevision = '2';
const bootstrapBefore2 = calls.bootstrap;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 1500));
check('商品版本變動 → 重新 bootstrap 一次', calls.bootstrap === bootstrapBefore2 + 1, `bootstrap=${calls.bootstrap - bootstrapBefore2}`);

/* 只有標籤變動時，不應該重抓 22,481 列商品 */
labelsRevision = '3';
const bootstrapBefore3 = calls.bootstrap;
const labelCallsBefore = calls.labelList;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 800));
check('只有標籤版本變動 → 完全不重抓商品', calls.bootstrap === bootstrapBefore3, `bootstrap=${calls.bootstrap - bootstrapBefore3}`);
check('只有標籤版本變動 → 只補抓標籤', calls.labelList > labelCallsBefore, `labels +${calls.labelList - labelCallsBefore}`);

/* ------------------------------------------ 情境 4：真的連不上時訊息要正確 */

console.log('\n=== 情境 4：API 真的不可用時 ===');
failBootstrap = true;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 300));
check('回報「無法連線雲端」並附原因', /無法連線雲端/.test(statusText()) && /D1 binding/.test(statusText()), statusText());
check('state.cloudEnabled = false', window.app.state.cloudEnabled === false);
failBootstrap = false;

/* ------------------------- 情境 5：雲端刪除失敗時，標籤不可以「刪了又復活」 */

console.log('\n=== 情境 5：刪除 PDF → 雲端失敗 → 同步後不可復活 ===');
failBootstrap = false;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 400));
const victimId = Object.keys(window.app.state.labels)[0];
check('測試前雲端與本機都有這個標籤', Boolean(window.app.state.labels[victimId]));

failDelete = true;                                     // 模擬 D1 額度用完 → 刪除失敗
await window.app.deleteLabels([victimId]);
await new Promise(r => setTimeout(r, 300));
check('本機立刻看不到這個標籤', !window.app.state.labels[victimId]);
check('有記下「刪除待確認」的墓碑', Boolean(window.app.state.tombstones[victimId]));
check('狀態訊息說明雲端尚未確認', /重試|未確認/.test(document.getElementById('toast').textContent)
  || /重試|未確認/.test(statusText()), document.getElementById('toast').textContent);

await window.app.reloadCloud();                        // 使用者按「同步」/重開頁
await new Promise(r => setTimeout(r, 600));
check('同步後標籤沒有被拉回來（關鍵：以前會復活）', !window.app.state.labels[victimId],
  Object.keys(window.app.state.labels).join(','));
check('雲端其實還沒刪掉（模擬失敗中）', cloudLabels.some(l => l.id === victimId));

failDelete = false;                                    // 雲端恢復
const flushed = await window.app.flushTombstones();
await new Promise(r => setTimeout(r, 200));
check('雲端恢復後會自動補刪', flushed >= 1, `補刪 ${flushed} 筆`);
check('雲端真的刪掉了', !cloudLabels.some(l => l.id === victimId), cloudLabels.map(l => l.id).join(','));
check('墓碑清掉（不會無限重試）', !window.app.state.tombstones[victimId]);

/* ------------------- 情境 6：改名／配對在雲端失敗後，同步要真的補送（含名稱） */

console.log('\n=== 情境 6：改名沒上傳 → 下次同步要補送名稱 ===');
failDelete = false;
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 500));
const renameId = Object.keys(window.app.state.labels)[0];
check('有一個標籤可以改名', Boolean(renameId));

failPatch = true;                                       // 模擬 D1 額度用完
await window.app.renameLabel(renameId, '改名後的商品名稱');
await new Promise(r => setTimeout(r, 300));
check('本機名稱已改', window.app.state.labels[renameId].nameFromFile === '改名後的商品名稱',
  window.app.state.labels[renameId].nameFromFile);
check('記下「待上傳」', window.app.pendingCount() >= 1, `${window.app.pendingCount()} 筆`);
check('訊息說明已記錄待上傳', /待上傳|自動補送/.test(document.getElementById('toast').textContent)
  || /待上傳/.test(statusText()), document.getElementById('toast').textContent);

failPatch = false;                                      // 雲端恢復
lastSyncRows = [];
const sent = await window.app.syncMatchMetadata();
await new Promise(r => setTimeout(r, 200));
check('同步會把待上傳的送出去', sent >= 1, `送出 ${sent} 筆`);
check('送出的內容包含改好的名稱', lastSyncRows.some(r => r.id === renameId && r.nameFromFile === '改名後的商品名稱'),
  JSON.stringify(lastSyncRows.find(r => r.id === renameId) || {}));
check('送出成功後清空待上傳', window.app.pendingCount() === 0, `${window.app.pendingCount()} 筆`);

/* --------------- 情境 7：只送有改動的（不會每次都重送全部標籤） */

console.log('\n=== 情境 7：同步只送有改動的標籤 ===');
lastSyncRows = [];
await window.app.syncMatchMetadata();
await new Promise(r => setTimeout(r, 150));
check('沒有改動時不會送任何標籤', lastSyncRows.length === 0, `${lastSyncRows.length} 筆`);

await window.app.markLabelDirty([renameId]);
lastSyncRows = [];
await window.app.syncMatchMetadata();
await new Promise(r => setTimeout(r, 150));
check('只有 1 筆改動時只送 1 筆（不是全部）', lastSyncRows.length === 1, `${lastSyncRows.length} 筆`);

/* --------------- 情境 8：配對不應該讓所有裝置重讀 22,481 列商品 */

console.log('\n=== 情境 8：配對完成後不會重抓全部商品 ===');
const revisionBefore = productsRevision;
const bootstrapBefore5 = calls.bootstrap;
await window.app.renameLabel(renameId, '再一次改名');
await new Promise(r => setTimeout(r, 300));
check('配對／改名不會改動商品版本號', productsRevision === revisionBefore, `${revisionBefore} → ${productsRevision}`);
await window.app.reloadCloud();
await new Promise(r => setTimeout(r, 600));
check('因此不會重新 bootstrap 22,481 列', calls.bootstrap === bootstrapBefore5, `bootstrap +${calls.bootstrap - bootstrapBefore5}`);

console.log(`\n=== 結果：${failures === 0 ? '全部通過' : `${failures} 項失敗`} ===`);
await db.deleteDatabase();
process.exit(failures ? 1 : 0);
