/*
 * 壓力測試：舊版 vs 新版的 174 個 PDF 匯入流程
 *
 * 執行：node tools/stress-test.mjs
 * 需要：npm i fake-indexeddb（僅測試用，不會部署）
 *
 * 測試會建立暫存的 IndexedDB（記憶體內），不會碰觸任何正式資料。
 */

import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
if (!globalThis.navigator) globalThis.navigator = {};
globalThis.navigator.storage = {
  estimate: async () => ({ quota: 6 * 1024 * 1024 * 1024, usage: 120 * 1024 * 1024 }),
  persist: async () => true
};

const { makeCatalog, makePdfFiles, totalBytes, mulberry32 } = await import('./fixtures.mjs');

// 後段測試只在意「檔案數量與流程行為」，用較小的 PDF 減少記憶體用量
const small = (catalog, count, seed) => makePdfFiles(catalog, count, { seed, minSize: 6 * 1024, maxSize: 30 * 1024 });
const realistic = (catalog, seed = 4711) => makePdfFiles(catalog, 174, { seed, minSize: 60 * 1024, maxSize: 900 * 1024 });
const medium = (catalog, seed) => makePdfFiles(catalog, 174, { seed, minSize: 60 * 1024, maxSize: 300 * 1024 });
const db = await import('../js/store/db.js');
const { buildIndex, matchFileName, bruteForceMatchIndexed } = await import('../js/core/matcher.js');
const { createImportPipeline, STATUS } = await import('../js/core/pipeline.js');
const { createTaskQueue, sleep } = await import('../js/core/queue.js');
const { contentHash, makeLabelId } = await import('../js/core/hash.js');
const legacy = await import('./legacy/legacy-match.mjs');

const results = [];
function record(name, data) {
  results.push({ name, ...data });
  console.log(`\n=== ${name} ===`);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object') continue;
    console.log(`  ${key}: ${value}`);
  }
  if (data.detail) console.log(`  ${JSON.stringify(data.detail)}`);
}

const ms = value => `${Math.round(value)}ms`;
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/* ------------------------------------------------------------------ T1/T2 */
// 舊版流程：saveLabelsLocal 失敗 → 整個批次停住
function legacyRunner({ files, catalog, failMode }) {
  const labels = {};
  const products = catalog.map(p => ({ ...p }));
  legacy.setLegacyState(products, labels);
  legacy.setLegacyFuse(null);
  const newLabels = [];
  let reached = 0;
  let flushCount = 0;

  const saveLabelsLocal = async () => {
    flushCount++;
    if (failMode === 'quota' && flushCount === 1) {
      const err = new Error('QuotaExceededError: quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return undefined;
  };

  const saveProducts = async () => {};
  const cloudSyncing = false;
  void cloudSyncing;

  async function run() {
    for (const [index, file] of files.entries()) {
      const id = `label_${Date.now()}_${index}`;
      const label = {
        filename: file.name,
        nameFromFile: file.name.replace(/\.pdf$/i, ''),
        blob: file,
        matchedProductName: null,
        matchSource: null,
        uploadedAt: new Date().toISOString()
      };
      labels[id] = label;
      newLabels.push(label);
      legacy.applyAutoMatch(label, false, false);
      reached = index + 1;
      if (reached % 10 === 0) await saveLabelsLocal(newLabels.splice(0));
      if (failMode === 'hang' && reached === 10) {
        // 模擬 iOS Safari 背景時 IndexedDB transaction 永遠不完成
        await new Promise(() => {});
      }
    }
    if (newLabels.length) await saveLabelsLocal(newLabels);
    await saveProducts(products);
    return { reached, error: null };
  }
  return { run, stats: () => ({ reached, flushCount, labels: Object.keys(labels).length }) };
}

{
  const catalog = makeCatalog(5000);
  const files = makePdfFiles(catalog, 174);
  const runner = legacyRunner({ files, catalog, failMode: 'quota' });
  let error = null;
  const started = performance.now();
  try {
    await runner.run();
  } catch (err) {
    error = err;
  }
  const elapsed = performance.now() - started;
  record('T1 舊流程：第一次批次儲存失敗（QuotaExceededError）', {
    '處理到的檔案': `${runner.stats().reached} / 174`,
    'UI 會停在': `本機處理中：${runner.stats().reached} / 174`,
    '拋出的錯誤': error ? error.name : '(沒有)',
    '耗時': ms(elapsed),
    '結論': '錯誤從 try 區塊逃出，finally 之後的 updateStats / 上傳 / 完成訊息全部不會執行'
  });
}

{
  const catalog = makeCatalog(5000);
  const files = makePdfFiles(catalog, 174);
  const runner = legacyRunner({ files, catalog, failMode: 'hang' });
  const started = performance.now();
  let settled = false;
  runner.run().then(() => { settled = true; }).catch(() => { settled = true; });
  await sleep(1200);
  record('T2 舊流程：IndexedDB transaction 永不完成（iOS 背景/鎖屏）', {
    '1.2 秒後是否結束': settled ? '是' : '否（永久 pending）',
    '處理到的檔案': `${runner.stats().reached} / 174`,
    'UI 狀態': `本機處理中：${runner.stats().reached} / 174（不再更新）`,
    '耗時': ms(performance.now() - started),
    '結論': 'await 永遠不會 resolve；沒有任何 onabort / timeout 可以救回'
  });
}

/* --------------------------------------------------------------------- T3 */
{
  const catalog = makeCatalog(5000);
  const files = makePdfFiles(catalog, 174).slice(0, 20);
  legacy.setLegacyState(catalog.map(p => ({ ...p })), {});
  legacy.setLegacyFuse(null);
  const started = performance.now();
  for (const file of files) legacy.findBestMatch(file.name.replace(/\.pdf$/i, ''));
  const perFile = (performance.now() - started) / files.length;
  record('T3 舊版自動配對成本（5,000 商品，無 Fuse 索引）', {
    '每個檔案': ms(perFile),
    '推算 174 個檔案': ms(perFile * 174),
    '產品數 × 檔案數': `${(5000 * 174).toLocaleString()} 次 matchScore 呼叫`,
    '說明': '這還只是配對；同一輪還有 products.forEach 清理 labelId、以及每個檔案 re-render'
  });
}

/* -------------------------------------------------------------------- T3b */
// 生產環境實際有 22,481 個商品，而且舊版每個檔案都會跑一次 Fuse.search（全庫）
{
  // 舊版每個檔案都會跑一次 Fuse.search（全庫）。Fuse 在合成資料上會非常慢，
  // 因此完整 Fuse 量測放在 tools/bench-real-catalog.mjs（用真實商品名）。
  // 這裡先量「不含 Fuse 的 products.forEach + matchScore」基準。
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let Fuse = null;
  if (process.env.BENCH_FUSE === '1') {
    try {
      Fuse = require('../vendor/fuse.min.js');
      if (Fuse && Fuse.default) Fuse = Fuse.default;
    } catch { /* ignore */ }
  }

  const catalog = makeCatalog(22481);
  const files = makePdfFiles(catalog, 174, { seed: 2026, minSize: 60 * 1024, maxSize: 200 * 1024 });
  legacy.setLegacyState(catalog.map(p => ({ ...p })), {});
  let fuseBuild = 0;
  if (Fuse) {
    const t = performance.now();
    const fuse = new Fuse(catalog, {
      keys: [{ name: 'name', weight: 0.7 }, { name: 'barcode', weight: 0.15 }, { name: 'barcode2', weight: 0.15 }],
      threshold: 0.55, ignoreLocation: true, includeScore: true, minMatchCharLength: 2
    });
    fuseBuild = performance.now() - t;
    legacy.setLegacyFuse(fuse);
  }
  const probe = files.slice(0, 3);
  const t1 = performance.now();
  for (const file of probe) legacy.findBestMatch(file.name.replace(/\.pdf$/i, ''));
  const legacyPer = (performance.now() - t1) / probe.length;

  const index = buildIndex(catalog);
  const t2 = performance.now();
  for (const file of files) matchFileName(index, file.name.replace(/\.pdf$/i, ''), {});
  const newTotal = performance.now() - t2;

  record('T3b 生產規模（22,481 商品 / 174 檔）：舊版 vs 新版配對', {
    '舊版 Fuse 索引建立': Fuse ? ms(fuseBuild) : '(未載入 Fuse)',
    '舊版每檔': ms(legacyPer),
    '舊版 174 檔（主執行緒阻塞）': `${(legacyPer * 174 / 1000).toFixed(1)} 秒`,
    '新版 174 檔（Worker）': ms(newTotal),
    '新版每檔': `${(newTotal / 174).toFixed(2)}ms`,
    '加速倍數': `${Math.round((legacyPer * 174) / newTotal)}×`,
    '說明': '這是「不含 Fuse」的基準；正式環境還會對 22,481 個商品跑 Fuse.search（見 tools/bench-real-catalog.mjs：1,220ms/檔，174 檔約 212 秒）'
  });
}

/* --------------------------------------------------------------------- T4 */
{
  const catalog = makeCatalog(5000);
  const files = makePdfFiles(catalog, 174);
  const index = buildIndex(catalog);
  const started = performance.now();
  const built = performance.now() - started;

  let mismatches = 0;
  let acceptedMismatches = 0;
  const examples = [];
  const t0 = performance.now();
  for (const file of files) {
    const name = file.name.replace(/\.pdf$/i, '');
    const fast = matchFileName(index, name, {});
    const fastId = fast ? fast.product.id : null;
    const fastConf = fast ? fast.confidence : 'none';
    const slow = bruteForceMatchIndexed(index, name, {});
    const slowId = slow ? slow.product.id : null;
    const slowConf = slow ? slow.confidence : 'none';
    if (fastId !== slowId || fastConf !== slowConf) {
      mismatches++;
      // 應用只採用 confidence !== 'low' 的結果，null 與 low 都代表「不配對」
      const fastEffective = fastConf === 'low' || fastConf === 'none' ? null : fastId;
      const slowEffective = slowConf === 'low' || slowConf === 'none' ? null : slowId;
      if (fastEffective !== slowEffective) {
        acceptedMismatches++;
        if (examples.length < 3) examples.push({ name, fastId, slowId, fastConf, slowConf });
      }
    }
  }
  const elapsed = performance.now() - t0;

  const t1 = performance.now();
  for (const file of files) matchFileName(index, file.name.replace(/\.pdf$/i, ''), {});
  const indexedOnly = performance.now() - t1;

  record('T4 新配對索引 vs 暴力比對（正確性驗證）', {
    '檔案數': files.length,
    '最佳解不一致（含低信心）': mismatches,
    '實際採用結果不一致': acceptedMismatches,
    '索引建立': ms(built),
    '只跑索引配對 174 檔': ms(indexedOnly),
    '平均每檔': `${(indexedOnly / files.length).toFixed(2)}ms`,
    detail: examples
  });
}

/* --------------------------------------------------------------------- T5 */
{
  for (const size of [5000, 20000]) {
    const catalog = makeCatalog(size);
    const files = makePdfFiles(catalog, 174);
    const t0 = performance.now();
    const index = buildIndex(catalog);
    const built = performance.now() - t0;
    const t1 = performance.now();
    for (const file of files) matchFileName(index, file.name.replace(/\.pdf$/i, ''), {});
    const matched = performance.now() - t1;
    record(`T5 新配對速度（${size.toLocaleString()} 商品 / 174 檔）`, {
      '索引建立': ms(built),
      '配對 174 檔': ms(matched),
      '平均每檔': `${(matched / 174).toFixed(2)}ms`,
      '在 Worker 執行': '是（主執行緒只收結果）'
    });
  }
}

/* ---------------------------------------------------------------- helpers */
async function freshDb(label) {
  await db.deleteDatabase();
  void label;
}

function makeUploader({ failRate = 0, latency = 35, seed = 99 } = {}) {
  const rand = mulberry32(seed);
  const attempts = new Map();
  const uploaded = new Set();
  const duplicated = new Set();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  return {
    async upload(label, file) {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const seen = (attempts.get(label.id) || 0) + 1;
      attempts.set(label.id, seen);
      try {
        await sleep(latency);
        if (uploaded.has(label.id)) {
          duplicated.add(label.id);
          return;
        }
        if (seen === 1 && rand() < failRate) {
          const err = new Error('模擬網路錯誤 503');
          err.status = 503;
          throw err;
        }
        uploaded.add(label.id);
      } finally {
        active--;
      }
    },
    stats: () => ({ calls, uploaded: uploaded.size, duplicated: duplicated.size, maxActive })
  };
}

function countedStore(extra = {}) {
  const counter = { blobWrites: 0, labelWrites: 0, productWrites: 0, txCount: 0 };
  return {
    counter,
    store: {
      ...db,
      storageEstimate: extra.storageEstimate || db.storageEstimate,
      async putBlob(hash, blob, meta) {
        counter.blobWrites++;
        return db.putBlob(hash, blob, meta);
      },
      async putLabel(label) {
        counter.labelWrites++;
        return db.putLabel(label);
      },
      async putProducts(list, chunk) {
        counter.productWrites++;
        return db.putProducts(list, chunk);
      }
    }
  };
}

async function runPipelineImport({ files, catalog, uploader, config = {}, storeExtra = {}, storageMode = 'auto', labels = null }) {
  const { store, counter } = countedStore(storeExtra);
  const index = buildIndex(catalog);
  const matcher = {
    setProducts() {},
    async matchBatch(items) {
      return items.map(item => {
        const best = matchFileName(index, item.name, {});
        return {
          key: item.key,
          result: best
            ? {
              productId: best.product.id,
              productName: best.product.name,
              score: Math.round(best.score),
              why: best.why,
              barcodeHit: best.barcodeHit,
              coverage: best.coverage,
              gap: Math.round(best.gap),
              confidence: best.confidence,
              secondBestId: best.secondBest ? best.secondBest.product.id : null
            }
            : null
        };
      });
    }
  };
  const pipeline = createImportPipeline({
    store,
    matcher,
    uploader,
    hooks: { onLog: () => {} },
    config: { concurrency: 2, matchBatchSize: 8, storageMode, ...config },
    contentHash,
    makeLabelId
  });
  pipeline.initUploadQueue(createTaskQueue);
  pipeline.setProducts(catalog);
  pipeline.setLabels(labels || {});
  pipeline.intake(files);
  await pipeline.decideStorageMode();
  const started = performance.now();
  await pipeline.start();
  const localMs = performance.now() - started;
  await pipeline.waitUploads();
  const elapsed = performance.now() - started;
  return { pipeline, counter, elapsed, localMs, summary: pipeline.summary(), uploader: uploader.stats() };
}

/* --------------------------------------------------------------------- T6 */
{
  await freshDb('T6');
  const catalog = makeCatalog(5000);
  const files = realistic(catalog);
  const uploader = makeUploader({ failRate: 0.15, latency: 35 });
  const { pipeline, counter, elapsed, localMs, summary, uploader: upStats } = await runPipelineImport({ files, catalog, uploader });
  const labels = Object.values(pipeline.getLabels());
  const matched = labels.filter(l => l.matchedProductName).length;
  record('T6 新流程：174 個 PDF 端到端（含 15% 上傳失敗 + 重試）', {
    '檔案總大小': mb(totalBytes(files)),
    '本機階段（儲存 + 配對）': ms(localMs),
    '本機階段每檔': `${(localMs / 174).toFixed(1)}ms`,
    '含上傳總耗時': ms(elapsed),
    '標籤數': labels.length,
    '自動配對成功': `${matched} (${Math.round((matched / labels.length) * 100)}%)`,
    '狀態分佈': JSON.stringify(summary.counts),
    'Blob 寫入次數': counter.blobWrites,
    '上傳呼叫次數': upStats.calls,
    '實際上傳成功': upStats.uploaded,
    '重複上傳': upStats.duplicated,
    '上傳最大並行': upStats.maxActive,
    '結論': '每個 PDF 只寫入一次 Blob；上傳失敗由佇列重試，不影響其他檔案'
  });
}

/* --------------------------------------------------------------------- T7 */
{
  // 重新選擇同一批 174 個 PDF：應全部判定為「已存在」，不重寫 Blob、不重複上傳
  const catalog = makeCatalog(5000);
  const files = realistic(catalog);
  const before = await db.getLabels();
  const labelsBefore = Object.keys(before).length;
  const uploader = makeUploader({ failRate: 0, latency: 5 });
  const { pipeline, counter, elapsed, summary, uploader: upStats } = await runPipelineImport({
    files, catalog, uploader, labels: before
  });
  const after = Object.keys(pipeline.getLabels()).length;
  record('T7 冪等性：同一批 174 個 PDF 重新選擇一次', {
    '匯入前標籤數': labelsBefore,
    '匯入後標籤數': after,
    '新增標籤': after - labelsBefore,
    '狀態分佈': JSON.stringify(summary.counts),
    '上傳呼叫': upStats.calls,
    'Blob 重寫次數': counter.blobWrites,
    '耗時': ms(elapsed),
    '結論': 'id = 內容 hash + 檔名 hash，重選同一批不會累積重複資料、不重寫 Blob、不重複上傳'
  });
}

/* --------------------------------------------------------------------- T8 */
{
  await freshDb('T8');
  const catalog = makeCatalog(5000);
  const files = small(catalog, 174, 222);
  // 第 3 個檔案故意壞掉（模擬讀取失敗 / 損壞的 File）
  const broken = files[2];
  Object.defineProperty(broken, 'slice', {
    value: () => { throw new Error('模擬：檔案讀取失敗'); }
  });
  const uploader = makeUploader({ failRate: 0, latency: 5 });
  const { pipeline, summary } = await runPipelineImport({ files, catalog, uploader });
  const failed = pipeline.getJobs().filter(j => j.status === STATUS.FAILED);
  record('T8 單檔失敗隔離', {
    '狀態分佈': JSON.stringify(summary.counts),
    '失敗檔案': failed.map(j => `${j.name} → ${j.error}`).join(' | ') || '(無)',
    '其餘檔案完成數': summary.counts.done || 0,
    '結論': '一個檔案失敗時，其他 173 個照樣完成'
  });
}

/* --------------------------------------------------------------------- T9 */
{
  await freshDb('T9');
  const catalog = makeCatalog(5000);
  const files = small(catalog, 174, 333);
  const uploader = makeUploader({ failRate: 0, latency: 20 });
  const { store } = countedStore();
  const index = buildIndex(catalog);
  const matcher = {
    setProducts() {},
    async matchBatch(items) {
      return items.map(item => {
        const best = matchFileName(index, item.name, {});
        return { key: item.key, result: best ? { productId: best.product.id, productName: best.product.name, score: Math.round(best.score), why: best.why, barcodeHit: best.barcodeHit, gap: Math.round(best.gap), confidence: best.confidence } : null };
      });
    }
  };
  const pipeline = createImportPipeline({
    store, matcher, uploader, hooks: { onLog: () => {} }, config: { storageMode: 'local' }, contentHash, makeLabelId
  });
  pipeline.initUploadQueue(createTaskQueue);
  pipeline.setProducts(catalog);
  pipeline.setLabels({});
  pipeline.intake(files);
  const running = pipeline.start();
  await sleep(45);
  pipeline.pause();
  const pausedCounts = JSON.stringify(pipeline.summary().counts);
  const pausedAt = pipeline.getJobs().filter(j => j.status !== STATUS.PENDING).length;
  await sleep(60);
  const stillPaused = pipeline.getJobs().filter(j => j.status !== STATUS.PENDING).length;
  pipeline.resume();
  await running.catch(() => {});
  await pipeline.waitUploads();
  const finalSummary = pipeline.summary();
  record('T9 暫停 / 繼續', {
    '暫停時已處理': `${pausedAt} 檔`,
    '暫停 60ms 後': `${stillPaused} 檔（沒有繼續增加）`,
    '暫停時狀態': pausedCounts,
    '繼續後完成': JSON.stringify(finalSummary.counts),
    '結論': '暫停只停止開啟新工作，已完成的檔案不會重做'
  });
}

/* -------------------------------------------------------------------- T10 */
{
  await freshDb('T10');
  const catalog = makeCatalog(5000);
  const files = medium(catalog, 444);
  const uploader = makeUploader({ failRate: 0, latency: 10 });
  const { pipeline, counter, summary } = await runPipelineImport({
    files,
    catalog,
    uploader,
    storeExtra: { storageEstimate: async () => ({ quota: 120 * 1024 * 1024, usage: 100 * 1024 * 1024 }) }
  });
  const labels = Object.values(pipeline.getLabels());
  record('T10 本機空間不足 → 自動切換「雲端優先」', {
    '檔案總大小': mb(totalBytes(files)),
    '可用配額': '約 20MB',
    '偵測到的模式': pipeline.getMode(),
    'Blob 寫入次數': counter.blobWrites,
    '仍保留 metadata 的標籤': labels.filter(l => !l.hasLocalBlob).length,
    '上傳完成': summary.counts.done || 0,
    '結論': '空間不足時不寫 Blob，只留 metadata，PDF 直接進 R2'
  });
}

/* ------------------------------------------------------------------- T10b */
{
  await freshDb('T10b');
  const catalog = makeCatalog(5000);
  const files = small(catalog, 174, 555);
  const uploader = makeUploader({ failRate: 0, latency: 5 });
  let blobAttempts = 0;
  const store = {
    ...db,
    storageEstimate: async () => ({ quota: 10 * 1024 * 1024 * 1024, usage: 0 }),
    async putBlob() {
      blobAttempts++;
      const err = new Error('QuotaExceededError: local storage full');
      err.name = 'QuotaExceededError';
      throw err;
    }
  };
  const index = buildIndex(catalog);
  const matcher = {
    setProducts() {},
    async matchBatch(items) {
      return items.map(item => {
        const best = matchFileName(index, item.name, {});
        return { key: item.key, result: best ? { productId: best.product.id, productName: best.product.name, score: Math.round(best.score), why: best.why, barcodeHit: best.barcodeHit, gap: Math.round(best.gap), confidence: best.confidence } : null };
      });
    }
  };
  const pipeline = createImportPipeline({
    store, matcher, uploader, hooks: { onLog: () => {} }, config: { storageMode: 'auto' }, contentHash, makeLabelId
  });
  pipeline.initUploadQueue(createTaskQueue);
  pipeline.setProducts(catalog);
  pipeline.setLabels({});
  pipeline.intake(files);
  await pipeline.decideStorageMode();
  await pipeline.start();
  await pipeline.waitUploads();
  const labels = Object.values(pipeline.getLabels());
  record('T10b 執行期才發現空間不足（QuotaExceededError）', {
    'Blob 寫入嘗試次數': blobAttempts,
    '最終模式': pipeline.getMode(),
    '完成的標籤': labels.length,
    '沒有本機 Blob 的標籤': labels.filter(l => !l.hasLocalBlob).length,
    '狀態分佈': JSON.stringify(pipeline.summary().counts),
    '結論': '第一個檔案寫入失敗後立刻切換雲端模式，其餘 173 個照樣完成'
  });
}

/* -------------------------------------------------------------------- T11 */
{
  const api = await import('../functions/api/[[path]].js');
  function mockEnv(options = {}) {
    const calls = [];
    const stmt = (sql, binds = []) => ({
      sql,
      binds,
      bind: (...args) => stmt(sql, args),
      run: async () => { calls.push({ sql, binds }); return { success: true }; },
      all: async () => { calls.push({ sql, binds }); return { results: [] }; },
      first: async () => {
        calls.push({ sql, binds });
        for (const [pattern, value] of options.firstResults || []) {
          if (pattern.test(sql)) return value;
        }
        return null;
      }
    });
    const DB = {
      prepare: sql => stmt(sql),
      batch: async list => { for (const item of list) calls.push({ sql: item.sql, binds: item.binds }); return []; }
    };
    const putKeys = [];
    const LABELS = {
      put: async key => { putKeys.push(key); },
      head: async () => (options.head === false ? null : { size: 100 }),
      get: async () => ({ body: null, size: 0, writeHttpMetadata() {}, httpEtag: 'x' }),
      delete: async () => {}
    };
    return { env: { DB, LABELS }, calls, putKeys };
  }

  const products = makeCatalog(3).map(p => ({ id: p.id, name: p.name, barcode: p.barcode, barcode2: p.barcode2 }));

  const a = mockEnv();
  await api.onRequestPost({
    request: new Request('https://example.com/api/products/bulk', {
      method: 'POST',
      body: JSON.stringify({ products, mode: 'merge' })
    }),
    env: a.env
  });
  const mergeDeleted = a.calls.some(c => /DELETE FROM products/i.test(c.sql));

  const b = mockEnv();
  await api.onRequestPost({
    request: new Request('https://example.com/api/products/bulk', {
      method: 'POST',
      body: JSON.stringify({ products, mode: 'replace' })
    }),
    env: b.env
  });
  const unconfirmedDeleted = b.calls.some(c => /DELETE FROM products/i.test(c.sql));

  const c = mockEnv();
  await api.onRequestPost({
    request: new Request('https://example.com/api/products/bulk', {
      method: 'POST',
      body: JSON.stringify({ products, mode: 'replace', confirm: 'REPLACE_ALL' })
    }),
    env: c.env
  });
  const confirmedDeleted = c.calls.some(c => /DELETE FROM products/i.test(c.sql));

  record('T11 API 安全性：商品批次寫入', {
    'mode=merge 是否 DELETE': mergeDeleted ? '是（危險）' : '否',
    'mode=replace（未確認）是否 DELETE': unconfirmedDeleted ? '是（危險）' : '否',
    'mode=replace + confirm 是否 DELETE': confirmedDeleted ? '是（預期）' : '否',
    '結論': '新版前端一律用 merge；只有明確 confirm 才會清空商品表'
  });

  // 上傳去重：DB 已有同 hash 的資料 + R2 已有物件 → 不重寫 R2
  const d = mockEnv({
    firstResults: [[/FROM labels WHERE id/i, { id: 'L1234-abcd', content_hash: 'deadbeef', r2_key: 'labels/L1234-abcd.pdf' }]]
  });
  const body = new FormData();
  body.append('file', new File([new Uint8Array(2048)], 'a.pdf', { type: 'application/pdf' }));
  body.append('id', 'L1234-abcd');
  body.append('hash', 'deadbeef');
  body.append('filename', 'a.pdf');
  const response = await api.onRequestPost({
    request: new Request('https://example.com/api/labels', { method: 'POST', body }),
    env: d.env
  });
  const payload = await response.json();
  record('T12 API 去重：同一份 PDF 再次上傳', {
    'R2 PUT 次數': d.putKeys.length,
    '回應': JSON.stringify(payload),
    '結論': '相同 id/hash 且 R2 已有物件時不重寫，只更新 D1 metadata'
  });
}

/* ------------------------------------------------------------------ 輸出 */
const out = { generatedAt: new Date().toISOString(), node: process.version, results };
writeFileSync(new URL('./stress-results.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n結果已寫入 tools/stress-results.json');
await db.deleteDatabase();
process.exit(0);
