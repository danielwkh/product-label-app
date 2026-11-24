/*
 * 商品標籤助手 — 主程式（ES module）
 *
 * 這個檔案只負責「畫面與使用者操作」，大量 PDF 的處理流程在：
 *   js/core/pipeline.js   每個檔案的狀態機、暫停/續傳/重試
 *   js/core/queue.js      有限並行上傳佇列
 *   js/core/match.worker.js  模糊配對（移出主執行緒）
 *   js/store/db.js        IndexedDB（metadata 與 PDF Blob 分開存放）
 *   js/store/api.js       Cloudflare Pages Functions / D1 / R2
 */

import * as db from './store/db.js';
import { createApi, ApiError } from './store/api.js';
import { createTaskQueue } from './core/queue.js';
import { createImportPipeline, STATUS } from './core/pipeline.js';
import { contentHash, makeLabelId } from './core/hash.js';
import { buildIndex, matchFileName, searchProducts } from './core/matcher.js';
import {
  normalize,
  normalizeName,
  compact,
  digits,
  barcodeTail6,
  isBarcodeQuery,
  barcodeMatchesTail
} from './core/text.js';
import { createJobsView, formatBytes } from './ui/jobs-view.js';
import { labelKind, extFromName, stripExtension } from './core/filetype.js';

const $ = id => document.getElementById(id);
const api = createApi({ base: './api/' });

const state = {
  products: [],
  labels: {},
  selectedLabelIds: new Set(),
  matchFilter: 'all',
  matchQuery: '',
  matchSort: 'status',
  renderLimit: 60,
  cloudEnabled: false,
  cloudError: null,
  cloudSyncing: false,
  remoteProducts: null,        // 上次 bootstrap 的 id → {name,barcode,barcode2}，用來只同步有變動的商品
  localSnapshotWriter: null,   // 測試用注入點
  localWarning: null,
  currentMatchLabelId: null,
  editingLabelId: null,
  preview: { url: null, labelId: null, pdf: null, page: 1 },
  scanning: null,
  blobCache: new Map()
};

/* --------------------------------------------------------------- 小工具 */

function toast(message, duration = 2600) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), duration);
}

function showStatus(id, message, type = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `status show${type ? ` ${type}` : ''}`;
}

function hideStatus(id) {
  const el = $(id);
  if (el) el.className = 'status';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const nowISO = () => new Date().toISOString();

function yieldMain() {
  return new Promise(resolve => (document.hidden ? resolve() : setTimeout(resolve, 0)));
}

/* ------------------------------------------------------- 配對引擎（Worker） */

function createMatcher() {
  let worker = null;
  let workerBroken = false;
  let seq = 0;
  const waiting = new Map();
  let fallbackIndex = null;   // 只有 worker 不可用時才在主要執行緒建立（避免啟動時卡住）
  let manualIds = new Set();
  let products = [];
  let pendingIndex = false;

  function ensureFallbackIndex() {
    if (!fallbackIndex) fallbackIndex = buildIndex(products);
    return fallbackIndex;
  }

  function serialise(list) {
    return (list || []).map(p => ({
      id: p.id,
      name: p.name,
      barcode: p.barcode || '',
      barcode2: p.barcode2 || '',
      labelId: p.labelId || null
    }));
  }

  function buildWorker() {
    if (worker || workerBroken || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(new URL('./core/match.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const msg = event.data || {};
        if (msg.type === 'indexed') return;
        const pending = waiting.get(msg.reqId);
        if (!pending) return;
        waiting.delete(msg.reqId);
        if (msg.type === 'error') pending.reject(new Error(msg.error));
        else pending.resolve(msg);
      };
      worker.onerror = err => {
        console.warn('配對 worker 失效，改用主執行緒', err && err.message);
        workerBroken = true;
        for (const [, pending] of waiting) pending.reject(new Error('worker error'));
        waiting.clear();
        worker = null;
      };
      worker.postMessage({ type: 'init', products: serialise(products) });
    } catch (err) {
      console.warn('無法建立配對 worker，改用主執行緒', err);
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function call(message, timeoutMs = 30000) {
    const w = buildWorker();
    if (!w) return Promise.reject(new Error('no worker'));
    const reqId = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        reject(new Error('配對 worker 逾時'));
      }, timeoutMs);
      waiting.set(reqId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      w.postMessage({ ...message, reqId });
    });
  }

  function inlineMatch(items) {
    const index = ensureFallbackIndex();
    return items.map(item => {
      const best = matchFileName(index, item.name, {
        manualLabelIds: manualIds,
        currentLabelId: item.labelId || null
      });
      if (!best) return { key: item.key, result: null };
      return {
        key: item.key,
        result: {
          productId: best.product.id,
          productName: best.product.name,
          score: Math.round(best.score),
          why: best.why,
          barcodeHit: best.barcodeHit,
          coverage: best.coverage,
          gap: Math.round(best.gap),
          confidence: best.confidence,
          secondBestId: best.secondBest ? best.secondBest.product.id : null,
          secondBestName: best.secondBest ? best.secondBest.product.name : null
        }
      };
    });
  }

  return {
    setProducts(list) {
      products = list || [];
      fallbackIndex = null;         // 延後建立：2 萬個商品的索引不要在啟動時卡主執行緒
      if (worker) worker.postMessage({ type: 'init', products: serialise(products) });
      else if (!workerBroken) buildWorker();
      pendingIndex = false;
    },
    setManualLabelIds(set) {
      manualIds = set || new Set();
    },
    async matchBatch(items) {
      if (!items.length) return [];
      try {
        const response = await call({ type: 'match', items, manualLabelIds: [...manualIds] });
        return response.results || [];
      } catch (err) {
        // worker 不可用時退回主執行緒，並逐批 yield，避免長時間凍結
        const out = [];
        for (let i = 0; i < items.length; i += 4) {
          out.push(...inlineMatch(items.slice(i, i + 4)));
          await yieldMain();
        }
        return out;
      }
    },
    async search(query, limit = 10) {
      try {
        const response = await call({ type: 'search', query, limit }, 10000);
        return response.items || [];
      } catch {
        return searchProducts(ensureFallbackIndex(), query, limit).map(p => ({
          id: p.id, name: p.name, barcode: p.barcode, barcode2: p.barcode2, labelId: p.labelId
        }));
      }
    },
    get debug() {
      return { worker: Boolean(worker), workerBroken, pendingIndex };
    }
  };
}

const matcher = createMatcher();

/* ------------------------------------------------------------- 匯入流程 */

const jobsView = createJobsView($('jobsCard'), {
  onPause: () => {
    pipeline.pause();
    showStatus('pdfStatus', '已暫停。可隨時按「繼續」接續，已完成的檔案不會重做。');
    toast('已暫停匯入');
  },
  onResume: () => {
    showStatus('pdfStatus', '繼續處理中…');
    pipeline.resume();
    toast('繼續匯入');
  },
  onRetry: async () => {
    const retried = await pipeline.retryFailed();
    const uploads = await pipeline.retryUploads();
    if (!retried && !uploads) {
      toast('沒有可重試的項目（重新整理後遺失的檔案需重新選擇）');
      return;
    }
    toast(`重試 ${retried} 個本機項目、${uploads} 個上傳項目`);
  },
  onClear: async () => {
    await pipeline.clearFinishedJobs();
    jobsView.reset();
    for (const job of pipeline.getJobs()) jobsView.update(job);
  }
});

const pipeline = createImportPipeline({
  store: {
    ...db,
    hasBlob: db.hasBlob,
    getBlobRecord: db.getBlobRecord,
    storageEstimate: db.storageEstimate
  },
  matcher,
  uploader: {
    enabled: () => state.cloudEnabled,
    async upload(label, file) {
      if (!state.cloudEnabled) throw Object.assign(new Error('雲端 API 尚未啟用'), { status: 503 });
      await api.uploadLabel(label, file);
      label.remote = true;
      label.uploaded = true;
    }
  },
  hooks: {
    onJob: job => jobsView.update(job),
    onSummary: summary => jobsView.summary(summary),
    onLog: message => console.info('[import]', message),
    onMode: mode => {
      if (mode === 'cloud') {
        showStatus('pdfStatus', '本機空間不足，已改用「雲端優先」：PDF 直接上傳 R2，本機只保留 metadata。', 'warn');
      }
    }
  },
  config: { concurrency: 2, matchBatchSize: 8, storageMode: 'auto' },
  contentHash,
  makeLabelId
});
pipeline.initUploadQueue(createTaskQueue);

let pdfIntakeRunning = false;
let cloudReady = null;

async function handlePdfSelection(fileList) {
  // 不再用副檔名過濾（.wdfx 等 PDF 改名的檔案要能進來）；
  // 只排除空檔案，真正格式由 pipeline 讀檔頭判斷。
  const all = Array.from(fileList || []);
  const files = all.filter(f => f && (f.size || 0) > 0);
  if (!files.length) {
    showStatus('pdfStatus', all.length
      ? '選到的檔案都是 0 bytes（可能是 iCloud 檔案還沒下載完成），請在「檔案」App 先開啟一次再選。'
      : '沒有選到檔案。如果 .wdfx 在選檔畫面是灰色或看不到，請看下面「選不到檔案？」的說明。', 'warn');
    toast('沒有選到可處理的檔案');
    return;
  }
  // 上一批若已全部結束，先清掉進度列，讓新的批次從乾淨的清單開始
  if (!pdfIntakeRunning) {
    const previous = pipeline.summary();
    const active = (previous.counts.pending || 0) + (previous.counts.hashing || 0) + (previous.counts.saving || 0)
      + (previous.counts.matching || 0) + (previous.counts.uploading || 0) + (previous.counts.ready || 0);
    if (previous.total > 0 && active === 0) {
      await pipeline.clearFinishedJobs();
      jobsView.reset();
    }
  }
  // 1. 立即顯示總數（不等任何 I/O）
  const before = pipeline.summary();
  const { added } = await pipeline.intake(files);
  const batchJobs = pipeline.getJobs().filter(j => j.status === STATUS.PENDING);
  void before;
  showStatus('pdfStatus', `已選取 ${files.length} 個檔案${added < files.length ? `（${files.length - added} 個重複略過）` : ''}，開始本機處理…`);
  jobsView.summary(pipeline.summary());

  if (pdfIntakeRunning) {
    toast('已加入佇列，會接續處理');
    return;
  }
  pdfIntakeRunning = true;
  try {
    pipeline.setProducts(state.products);
    pipeline.setLabels(state.labels);
    await pipeline.decideStorageMode();
    await pipeline.start();
    const batch = new Set(batchJobs.map(j => j.id));
    const current = pipeline.getJobs().filter(j => batch.has(j.id));
    const count = status => current.filter(j => j.status === status).length;
    const failed = count(STATUS.FAILED);
    const dup = count(STATUS.DUPLICATE);
    const finished = count(STATUS.DONE) + count(STATUS.READY) + count(STATUS.UPLOADING) + count(STATUS.DUPLICATE);
    const matchedCount = current.filter(j => {
      const label = j.labelId ? state.labels[j.labelId] : null;
      return Boolean(label && label.matchedProductName);
    }).length;
    showStatus(
      'pdfStatus',
      `本批 ${current.length} 個檔案：已完成 ${finished} 個${dup ? `（${dup} 個之前已存在而略過）` : ''}、自動配對 ${matchedCount} 個${failed ? `、${failed} 個失敗（可按「重試失敗」）` : ''}。`
    );
    if (state.cloudEnabled) await pipeline.waitUploads();
    await refreshStateFromPipeline();
    if (state.cloudEnabled) await syncMatchMetadata();
  } catch (err) {
    console.error(err);
    showStatus('pdfStatus', `處理過程發生錯誤：${err.message}`, 'error');
  } finally {
    pdfIntakeRunning = false;
    await refreshStateFromPipeline();
  }
}

async function refreshStateFromPipeline() {
  // pipeline 直接修改 state.labels 內的物件，這裡只需要重畫
  state.labels = pipeline.getLabels();
  matcher.setManualLabelIds(manualLabelIdSet());
  updateStats();
  renderMatchList();
}

function manualLabelIdSet() {
  const set = new Set();
  for (const label of Object.values(state.labels)) {
    if (label && label.matchSource === 'manual') set.add(label.id);
  }
  return set;
}

/* ------------------------------------------------------------------ 雲端 */

function mergeRemoteLabels(remoteLabels) {
  const merged = { ...state.labels };
  for (const remote of remoteLabels) {
    const local = merged[remote.id];
    merged[remote.id] = {
      id: remote.id,
      filename: remote.filename,
      nameFromFile: remote.nameFromFile || remote.filename,
      hash: remote.hash || (local && local.hash) || null,
      size: remote.size || (local && local.size) || 0,
      productId: remote.productId ?? null,
      matchedProductName: remote.matchedProductName || null,
      matchSource: remote.matchSource || null,
      matchScore: remote.matchScore ?? null,
      matchConfidence: remote.matchConfidence || null,
      matchGap: remote.matchGap ?? null,
      matchWhy: remote.matchWhy || null,
      uploadedAt: remote.uploadedAt || (local && local.uploadedAt) || nowISO(),
      updatedAt: remote.updatedAt || null,
      deferred: Boolean(remote.deferred) || Boolean(local && local.deferred),
      hasLocalBlob: Boolean(local && local.hasLocalBlob),
      uploaded: true,
      remote: true
    };
  }
  state.labels = merged;
  for (const label of Object.values(state.labels)) {
    if (!label.uploaded) label.remote = false;
  }
}

async function persistLocalSnapshot(products, onProgress) {
  if (state.localSnapshotWriter) return state.localSnapshotWriter(products);
  return db.saveProductsChunked(products, { chunkSize: 800, onProgress, yieldFn: yieldMain });
}

function productSignature(products) {
  if (!products.length) return '0:';
  let maxUpdated = '';
  for (const product of products) {
    const value = String(product.updatedAt || '');
    if (value > maxUpdated) maxUpdated = value;
  }
  return `${products.length}:${maxUpdated}`;
}

async function cloudRequestSafe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[cloud] ${label} 失敗`, err);
    throw err;
  }
}

async function loadCloudData() {
  showStatus('cloudStatus', '連線雲端中…');
  try {
    // 1) 先用「便宜」的 revision 檢查（只讀 2 列），避免每次開頁都抓 22,481 列商品，
    //    這同時是 D1 免費額度（500 萬列讀取/日）會不會被燒完的關鍵。
    let meta = null;
    try {
      meta = await api.meta();
    } catch (err) {
      console.warn('[cloud] meta 檢查失敗，改用完整 bootstrap', err);
    }

    if (meta && meta.cloud && !meta.degraded) {
      state.cloudEnabled = true;
      state.cloudError = null;

      // 商品與標籤分開比版本：
      //   商品很少變動（22,481 列，讀一次很貴），標籤常常變動（幾百列）。
      //   只有「商品版本」變了才需要整包 bootstrap；只改標籤時完全不碰商品表。
      const storedProductsRev = await db.getMeta('cloudProductsRevision');
      const storedLabelsRev = await db.getMeta('cloudLabelsRevision');
      const localCount = await db.countProducts();
      const productsFresh = localCount > 0
        && localCount === state.products.length
        && storedProductsRev === String(meta.productsRevision);

      if (productsFresh) {
        let labelsChanged = storedLabelsRev !== String(meta.labelsRevision);
        if (labelsChanged) {
          try {
            const labelData = await api.labelList();
            mergeRemoteLabels(labelData.labels || []);
            await db.putLabels(Object.values(state.labels), 40).catch(() => {});
            await db.setMeta('cloudLabelsRevision', String(meta.labelsRevision)).catch(() => {});
          } catch (err) {
            console.warn('[cloud] 標籤同步失敗', err);
            labelsChanged = false;
          }
        }
        pipeline.setProducts(state.products);
        pipeline.setLabels(state.labels);
        matcher.setProducts(state.products);
        matcher.setManualLabelIds(manualLabelIdSet());
        showStatus('cloudStatus', `已連線雲端：${state.products.length.toLocaleString()} 個商品（本機快取）、${Object.keys(state.labels).length} 個標籤`
          + `${labelsChanged ? '（已更新）' : ''}`);
        return true;
      }
    }

    const data = await api.bootstrap(meta && meta.revision);
    if (!data || !data.cloud) {
      state.cloudEnabled = false;
      state.cloudError = data && data.error ? data.error : '雲端 API 未啟用';
      showStatus('cloudStatus', `目前使用本機資料：${state.cloudError}`, 'error');
      return false;
    }

    // 雲端可用就先確定下來；之後本機快取寫入失敗也不應該讓它變回 false
    state.cloudEnabled = true;
    state.cloudError = null;

    const remoteProducts = data.products || [];
    const remoteLabels = data.labels || [];
    const hasRemote = remoteProducts.length > 0 || remoteLabels.length > 0;

    if (remoteProducts.length) {
      const localById = new Map(state.products.map(p => [p.id, p]));
      state.products = remoteProducts.map(p => {
        const local = localById.get(p.id);
        return {
          id: p.id,
          name: p.name,
          barcode: p.barcode || '',
          barcode2: p.barcode2 || '',
          labelId: p.labelId || (local && local.labelId) || null
        };
      });
      state.remoteProducts = new Map(state.products.map(p => [p.id, {
        name: p.name, barcode: p.barcode || '', barcode2: p.barcode2 || '', labelId: p.labelId || null
      }]));
    }

    mergeRemoteLabels(remoteLabels);

    pipeline.setProducts(state.products);
    pipeline.setLabels(state.labels);
    matcher.setProducts(state.products);
    matcher.setManualLabelIds(manualLabelIdSet());

    // ---- 本機離線快取：獨立處理，失敗只警告 ----
    state.localWarning = null;
    if (remoteProducts.length) {
      try {
        const signature = productSignature(state.products);
        const savedSignature = await db.getMeta('productsSignature');
        const localCount = await db.countProducts();
        if (signature !== savedSignature || localCount !== state.products.length) {
          showStatus('cloudStatus', `已連線雲端，正在建立本機離線快取（${state.products.length.toLocaleString()} 個商品）…`);
          await persistLocalSnapshot(state.products, (done, total) => {
            if (done === total || done % 8000 === 0) {
              showStatus('cloudStatus', `已連線雲端，本機快取 ${done.toLocaleString()} / ${total.toLocaleString()}`);
            }
          });
          await db.setMeta('productsSignature', signature);
        }
      } catch (err) {
        state.localWarning = err && err.message ? err.message : String(err);
        console.warn('[cloud] 本機快取寫入失敗（不影響雲端連線）', err);
      }
    }

    if (remoteLabels.length) {
      try {
        await db.putLabels(Object.values(state.labels), 40);
      } catch (err) {
        console.warn('[cloud] 標籤本機快取寫入失敗', err);
      }
    }

    if (data) {
      if (data.productsRevision != null) await db.setMeta('cloudProductsRevision', String(data.productsRevision)).catch(() => {});
      if (data.labelsRevision != null) await db.setMeta('cloudLabelsRevision', String(data.labelsRevision)).catch(() => {});
    }
    const base = hasRemote
      ? `已連線雲端：${state.products.length.toLocaleString()} 個商品、${Object.keys(state.labels).length} 個標籤`
      : '已連線雲端；雲端目前沒有資料，可同步本機資料';
    showStatus('cloudStatus', state.localWarning ? `${base}（本機快取寫入失敗：${state.localWarning}）` : base, state.localWarning ? 'warn' : '');
    return true;
  } catch (err) {
    state.cloudEnabled = false;
    state.cloudError = err && err.message ? err.message : String(err);
    showStatus('cloudStatus', `無法連線雲端：${state.cloudError}（目前使用本機資料）`, 'error');
    return false;
  }
}

async function syncMatchMetadata() {
  if (!state.cloudEnabled) return;
  const remote = Object.values(state.labels).filter(l => l.uploaded);
  const chunk = 200;
  for (let i = 0; i < remote.length; i += chunk) {
    const slice = remote.slice(i, i + chunk).map(l => ({
      id: l.id,
      productId: l.productId ?? null,
      matchedProductName: l.matchedProductName || null,
      matchSource: l.matchSource || null,
      matchScore: l.matchScore ?? null,
      matchConfidence: l.matchConfidence || null,
      matchGap: l.matchGap ?? null,
      matchWhy: l.matchWhy || null
    }));
    try {
      await cloudRequestSafe(() => api.syncLabelMeta(slice), 'labels/sync');
    } catch {
      break;
    }
  }
}

async function syncAllToCloud() {
  const button = $('syncCloudBtn');
  if (state.cloudSyncing) return;

  // 若還沒確認過雲端，先連線（使用者在 bootstrap 完成前就按按鈕也不會誤報）
  if (!state.cloudEnabled) {
    showStatus('cloudStatus', '連線雲端中…');
    if (cloudReady) {
      try { await cloudReady; } catch { /* ignore */ }
    }
    if (!state.cloudEnabled) await loadCloudData();
    if (!state.cloudEnabled) {
      showStatus('cloudStatus', `無法連線雲端：${state.cloudError || '未知錯誤'}（目前使用本機資料）`, 'error');
      return;
    }
  }

  state.cloudSyncing = true;
  if (button) button.disabled = true;
  try {
    // 1) 商品：只送「與雲端不同」的（22,481 筆一次全送會很慢）
    const remote = state.remoteProducts;
    const changed = state.products.filter(p => {
      if (!remote) return true;
      const row = remote.get(p.id);
      return !row || row.name !== p.name || row.barcode !== (p.barcode || '') || row.barcode2 !== (p.barcode2 || '') || row.labelId !== (p.labelId || null);
    });
    if (!state.products.length) {
      showStatus('cloudStatus', '本機沒有商品資料，請先上傳 Excel', 'error');
      return;
    }
    if (changed.length) {
      const chunkSize = 500;
      for (let i = 0; i < changed.length; i += chunkSize) {
        const chunk = changed.slice(i, i + chunkSize).map(p => ({
          id: p.id, name: p.name, barcode: p.barcode || '', barcode2: p.barcode2 || '', labelId: p.labelId || null
        }));
        await api.productsBulk(chunk, { replace: false });
        showStatus('cloudStatus', `同步商品中：${Math.min(i + chunkSize, changed.length).toLocaleString()} / ${changed.length.toLocaleString()}`);
        await yieldMain();
      }
    }
    state.remoteProducts = new Map(state.products.map(p => [p.id, {
      name: p.name, barcode: p.barcode, barcode2: p.barcode2, labelId: p.labelId || null
    }]));

    // 2) 本機有 blob 但雲端還沒有的標籤 → 排入上傳佇列（只呼叫一次）
    const pending = Object.values(state.labels).filter(l => l.hasLocalBlob && !l.uploaded);
    let queued = 0;
    if (pending.length) {
      showStatus('cloudStatus', `排入 ${pending.length} 個本機 PDF 上傳…`);
      queued = await pipeline.retryUploads();
      await pipeline.waitUploads();
    }

    // 3) 舊版本留下、沒有對應 job 的標籤：用本機 blob 直接補上傳
    let legacyUploaded = 0;
    for (const label of pending) {
      if (label.uploaded) continue;
      const record = label.hash ? await db.getBlobRecord(label.hash) : null;
      if (!record || !record.blob) continue;
      try {
        await api.uploadLabel(label, record.blob);
        label.uploaded = true;
        label.remote = true;
        await db.putLabel(label);
        legacyUploaded++;
      } catch (err) {
        console.warn('上傳標籤失敗', label.id, err);
      }
    }

    // 4) 配對結果
    await syncMatchMetadata();
    await refreshStateFromPipeline();

    try {
      const latest = await api.meta();
      if (latest) {
        if (latest.productsRevision != null) await db.setMeta('cloudProductsRevision', String(latest.productsRevision));
        if (latest.labelsRevision != null) await db.setMeta('cloudLabelsRevision', String(latest.labelsRevision));
      }
    } catch { /* 記不到 revision 只會讓下次多抓一次 bootstrap */ }

    const parts = [`商品 ${changed.length ? `已同步 ${changed.length.toLocaleString()} 筆` : '已是最新（無變動）'}`];
    if (queued || legacyUploaded) parts.push(`PDF 上傳 ${queued + legacyUploaded} 個`);
    showStatus('cloudStatus', `同步完成：${parts.join('、')}`);
    toast('雲端同步完成');
  } catch (err) {
    showStatus('cloudStatus', `同步失敗：${err.message}`, 'error');
  } finally {
    state.cloudSyncing = false;
    if (button) button.disabled = false;
  }
}

/* ------------------------------------------------------------- Excel 匯入 */

function findCol(headers, cands) {
  return headers.find(h => cands.some(c => normalize(h).includes(normalize(c)) || normalize(c).includes(normalize(h))));
}

async function importExcel(file) {
  showStatus('excelStatus', '讀取中…');
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) throw new Error('Excel 沒有資料');

  const headers = Object.keys(rows[0]);
  const nameCol = findCol(headers, ['名稱', '商品名稱', '品名', 'name', 'product']);
  const barcodeCol = findCol(headers, ['條碼', 'barcode', 'bar code', '主條碼']);
  const barcode2Col = findCol(headers, ['第二條碼', '副條碼', 'barcode2', 'second', 'barcode 2']);
  if (!nameCol) throw new Error('找不到「名稱」欄位');

  // 用「正規化名稱」保留舊 id 與既有配對，避免每次上傳 Excel 都改寫商品 id
  const oldByName = new Map(state.products.map(p => [normalize(p.name), p]));
  let nextId = state.products.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;

  const products = [];
  for (const row of rows) {
    const name = String(row[nameCol] || '').trim();
    if (!name) continue;
    const old = oldByName.get(normalize(name));
    products.push({
      id: old ? old.id : nextId++,
      name,
      barcode: String(row[barcodeCol] || '').trim(),
      barcode2: String(row[barcode2Col] || '').trim(),
      labelId: old ? old.labelId || null : null
    });
  }
  state.products = products;
  await db.replaceProducts(products);
  pipeline.setProducts(products);
  matcher.setProducts(products);
  updateStats();
  showStatus('excelStatus', `已載入 ${products.length} 個商品，正在重新配對標籤…`);

  // 重新配對（在 worker 內分批執行，UI 不會凍結）
  const total = Object.values(state.labels).length;
  await pipeline.rematchAll({
    onProgress: (done, all) => {
      if (done === all || done % 40 === 0) showStatus('excelStatus', `重新配對中：${done} / ${all}`);
    }
  });
  await refreshStateFromPipeline();
  if (state.cloudEnabled) {
    const list = products.map(p => ({ id: p.id, name: p.name, barcode: p.barcode, barcode2: p.barcode2, labelId: p.labelId || null }));
    for (let i = 0; i < list.length; i += 200) {
      try {
        await api.productsBulk(list.slice(i, i + 200), { replace: false });
      } catch (err) {
        showStatus('excelStatus', `商品已存本機，雲端同步失敗：${err.message}`, 'error');
        return;
      }
    }
    await syncMatchMetadata();
    try {
      const latest = await api.meta();
      if (latest) {
        if (latest.productsRevision != null) await db.setMeta('cloudProductsRevision', String(latest.productsRevision));
        if (latest.labelsRevision != null) await db.setMeta('cloudLabelsRevision', String(latest.labelsRevision));
      }
    } catch { /* ignore */ }
  }
  showStatus('excelStatus', `成功載入 ${products.length} 個商品；已重新檢查 ${total} 個標籤，人工配對會保留`);
  toast('Excel 上傳成功');
}

/* ------------------------------------------------------------ 配對管理 UI */

function getLabelProduct(label) {
  if (!label) return null;
  if (label.productId != null) {
    const byId = state.products.find(p => p.id === label.productId);
    if (byId) return byId;
  }
  if (label.matchedProductName) return state.products.find(p => p.name === label.matchedProductName) || null;
  return null;
}

/* ------------------------------------------------- 重複標籤 / 編輯刪除 */

// 重複判定：以 PDF 內容指紋（hash）為主；舊資料沒有 hash 時退回用名稱
function labelDupKey(label) {
  const hash = label.hash || label.contentHash;
  if (hash) return `h:${hash}`;
  return `n:${normalize(label.nameFromFile || label.filename || '')}`;
}

// 「同名」判定：去掉副檔名後，只保留中英數字（忽略空白、_、-、（）、. 等檔名雜訊）
// 用途：抓出「同一張標籤的 PDF 與轉檔後的 .wdfx」這種內容不同但其實重複的檔案
function labelNameKey(label) {
  const base = stripExtension(label.nameFromFile || label.filename || '');
  return base.toLowerCase().replace(/[^0-9a-z\u3400-\u9fff]+/g, '');
}

function groupBy(labels, keyOf) {
  const groups = new Map();
  for (const label of labels) {
    const key = keyOf(label);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(label);
  }
  return groups;
}

// 回傳 Map<labelId, { size, type }>；type = 'content'（完全相同）或 'name'（同名不同檔）
function duplicateMap(labels) {
  const map = new Map();
  const contentGroups = groupBy(labels, label => (label.hash ? `h:${label.hash}` : null));
  for (const list of contentGroups.values()) {
    if (list.length < 2) continue;
    for (const label of list) map.set(label.id, { size: list.length, type: 'content' });
  }
  const nameGroups = groupBy(labels, labelNameKey);
  for (const list of nameGroups.values()) {
    if (list.length < 2) continue;
    const distinct = new Set(list.map(label => label.hash || `id:${label.id}`));
    for (const label of list) {
      const current = map.get(label.id);
      if (current && current.type === 'content') continue;
      map.set(label.id, { size: list.length, type: distinct.size > 1 ? 'name' : 'content' });
    }
  }
  return map;
}

// 每組保留哪一筆：人工配對優先 → 已配對 → 最新上傳
function pickKeeper(list) {
  const score = label => (label.matchSource === 'manual' ? 3 : label.matchedProductName ? 2 : 1);
  return [...list].sort((a, b) => score(b) - score(a)
    || String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))[0];
}

function extraDuplicateIds(labels) {
  const extras = new Set();

  // 第一層：內容完全相同（同 hash）→ 只留一筆
  const contentGroups = groupBy(labels, label => (label.hash ? `h:${label.hash}` : null));
  for (const list of contentGroups.values()) {
    if (list.length < 2) continue;
    const keeper = pickKeeper(list);
    for (const label of list) if (label.id !== keeper.id) extras.add(label.id);
  }

  // 第二層：同名不同檔（例如 PDF 與轉檔後的 .wdfx）→ 每一種內容各留一筆代表後，再只留一筆
  const nameGroups = groupBy(labels, labelNameKey);
  for (const list of nameGroups.values()) {
    if (list.length < 2) continue;
    const representatives = [];
    const seen = new Set();
    for (const label of list) {
      const key = label.hash || `id:${label.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      representatives.push(label);
    }
    if (representatives.length < 2) continue;
    const keeper = pickKeeper(representatives);
    for (const label of representatives) if (label.id !== keeper.id) extras.add(label.id);
  }

  return [...extras];
}

// 刪除標籤：雲端（R2 + D1）、本機（IndexedDB + Blob）、商品連結一起處理
async function deleteLabels(ids, options = {}) {
  const targets = ids.map(id => state.labels[id]).filter(Boolean);
  if (!targets.length) return 0;

  let cloudFailed = 0;
  const cloudIds = targets.filter(label => label.uploaded).map(label => label.id);
  if (state.cloudEnabled && cloudIds.length) {
    // 伺服器一次最多 300 筆 → 這裡分批 250，避免一次請求太大
    for (let i = 0; i < cloudIds.length; i += 250) {
      const chunk = cloudIds.slice(i, i + 250);
      try {
        if (chunk.length === 1) await api.deleteLabel(chunk[0]);
        else await api.bulkDeleteLabels(chunk);
      } catch (err) {
        cloudFailed += chunk.length;
        console.warn('[labels] 雲端刪除失敗，僅刪除本機', err);
      }
    }
  }

  const changedProducts = [];
  for (const label of targets) {
    const stillUsed = Object.values(state.labels)
      .some(other => other.id !== label.id && other.hash && other.hash === label.hash);
    try { await db.deleteLabelRecord(label.id); } catch (err) { console.warn('[labels] 本機記錄刪除失敗', err); }
    if (label.hash && !stillUsed) {
      try { await db.deleteBlob(label.hash); } catch (err) { console.warn('[labels] 本機 Blob 刪除失敗', err); }
    }
    for (const product of state.products) {
      if (product.labelId === label.id) {
        product.labelId = null;
        changedProducts.push(product);
      }
    }
    delete state.labels[label.id];
    state.selectedLabelIds.delete(label.id);
  }
  if (changedProducts.length) {
    try { await db.putProducts(changedProducts); } catch (err) { console.warn('[labels] 商品連結更新失敗', err); }
  }

  try {
    pipeline.setLabels(state.labels);
    matcher.setManualLabelIds(manualLabelIdSet());
  } catch (err) { console.warn('[labels] 重新整理配對索引失敗', err); }
  updateStats();
  renderMatchList();
  if (!options.silent) {
    toast(cloudFailed
      ? `已在本機刪除 ${targets.length} 筆；雲端刪除失敗（下次連線補做）`
      : `已刪除 ${targets.length} 個標籤`);
  }
  return targets.length;
}

async function renameLabel(id, rawName) {
  const label = state.labels[id];
  if (!label) return false;
  const name = String(rawName || '').trim().slice(0, 200);
  if (!name) {
    toast('名稱不能空白');
    return false;
  }
  if (name === (label.nameFromFile || '')) return true;

  label.nameFromFile = name;
  label.updatedAt = nowISO();
  try { await db.putLabel(label); } catch (err) { console.warn('[labels] 本機名稱更新失敗', err); }

  let cloudNote = '';
  if (state.cloudEnabled && label.uploaded) {
    try {
      await api.patchLabel(id, { nameFromFile: name });
    } catch (err) {
      cloudNote = '（雲端尚未更新，稍後按「同步」會補送）';
      console.warn('[labels] 改名同步失敗', err);
    }
  }
  try { pipeline.setLabels(state.labels); } catch { /* ignore */ }
  renderMatchList();
  toast(`已更新標籤名稱${cloudNote}`);
  return true;
}

/* ----------------------------------------------------- 稍後處理（延後配對） */

async function setDeferred(ids, value) {
  const targets = ids.map(id => state.labels[id]).filter(Boolean);
  if (!targets.length) return 0;
  const cloudBatch = [];
  for (const label of targets) {
    label.deferred = Boolean(value);
    label.updatedAt = nowISO();
    try { await db.putLabel(label); } catch (err) { console.warn('[defer] 本機更新失敗', err); }
    if (state.cloudEnabled && label.uploaded) {
      cloudBatch.push({
        id: label.id,
        productId: label.productId,
        matchedProductName: label.matchedProductName,
        matchSource: label.matchSource,
        matchScore: label.matchScore,
        matchConfidence: label.matchConfidence,
        matchGap: label.matchGap,
        matchWhy: label.matchWhy,
        deferred: value
      });
    }
  }
  // 一次請求搞定（/api/labels/sync 支援 deferred），避免幾百個 PATCH
  for (let i = 0; i < cloudBatch.length; i += 200) {
    try {
      await api.syncLabelMeta(cloudBatch.slice(i, i + 200));
    } catch (err) {
      console.warn('[defer] 雲端更新失敗（下次按同步會補）', err);
    }
  }
  renderMatchList();
  return targets.length;
}

async function deferSelected(value) {
  const ids = [...state.selectedLabelIds];
  if (!ids.length) {
    toast(`請先勾選要${value ? '延後' : '取消延後'}的標籤`);
    return;
  }
  const count = await setDeferred(ids, value);
  state.selectedLabelIds.clear();
  updateSelectionUI([]);
  renderMatchList();
  toast(value ? `已把 ${count} 個標籤移到最後面` : `已把 ${count} 個標籤移回清單`);
}

async function deferAllUnmatched() {
  const ids = Object.values(state.labels)
    .filter(label => !label.matchedProductName && !label.deferred)
    .map(label => label.id);
  if (!ids.length) {
    toast('目前沒有未配對的標籤');
    return;
  }
  if (!confirm(`把 ${ids.length} 個未配對的標籤全部移到清單最後面？（之後可在「⏳ 已延後」找回）`)) return;
  const count = await setDeferred(ids, true);
  state.matchFilter = 'unmatched';
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'unmatched'));
  renderMatchList();
  toast(`已延後 ${count} 個標籤；未配對清單剩 ${Object.values(state.labels).filter(l => !l.matchedProductName && !l.deferred).length} 筆`);
}

/* --------------------------------------------------------- 格式管理（PDF / WDFX） */

function formatOf(label) {
  return String(label.ext || extFromName(label.filename) || '').toLowerCase();
}

function formatSummary() {
  const labels = Object.values(state.labels);
  const pdf = labels.filter(label => formatOf(label) === 'pdf');
  const wdfx = labels.filter(label => formatOf(label) === 'wdfx');
  const hasWdfxTwin = label => {
    const key = labelNameKey(label);
    return labels.some(other => other.id !== label.id && labelNameKey(other) === key && formatOf(other) === 'wdfx');
  };
  return {
    pdf,
    wdfx,
    pdfWithTwin: pdf.filter(hasWdfxTwin),
    pdfWithoutTwin: pdf.filter(label => !hasWdfxTwin(label))
  };
}

// 把配對（含人工鎖定）從一份檔案搬到另一份
async function transferMatch(from, to) {
  to.productId = from.productId ?? null;
  to.matchedProductName = from.matchedProductName || null;
  to.matchSource = from.matchSource || null;
  to.matchScore = from.matchScore ?? null;
  to.matchConfidence = from.matchConfidence || null;
  to.matchGap = from.matchGap ?? null;
  to.matchWhy = from.matchWhy ?? null;
  to.updatedAt = nowISO();

  try { await db.putLabel(to); } catch (err) { console.warn('[format] 本機配對更新失敗', err); }
  const touched = state.products.filter(product => product.labelId === from.id || product.labelId === to.id);
  for (const product of touched) product.labelId = to.id;
  if (touched.length) {
    try { await db.putProducts(touched); } catch (err) { console.warn('[format] 商品連結更新失敗', err); }
  }
  if (state.cloudEnabled && to.uploaded) {
    try {
      await api.patchLabel(to.id, {
        productId: to.productId,
        matchedProductName: to.matchedProductName,
        matchSource: to.matchSource,
        matchScore: to.matchScore,
        matchConfidence: to.matchConfidence,
        matchGap: to.matchGap,
        matchWhy: to.matchWhy
      });
    } catch (err) { console.warn('[format] 雲端配對轉移失敗', err); }
  }
}

// 每一組同名檔案只留 .wdfx，PDF 刪掉（配對先轉移過去）
async function keepOnlyWdfx() {
  const labels = Object.values(state.labels);
  const groups = groupBy(labels, labelNameKey);
  const toDelete = [];
  const transfers = [];
  let groupsHandled = 0;

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const wdfx = list.filter(label => formatOf(label) === 'wdfx');
    const others = list.filter(label => formatOf(label) !== 'wdfx');
    if (!wdfx.length || !others.length) continue;
    const keeper = wdfx.find(label => label.matchedProductName) || wdfx.slice().sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))[0];
    const donor = others.find(label => label.matchedProductName);
    if (donor && !keeper.matchedProductName) transfers.push({ from: donor, to: keeper });
    for (const label of others) toDelete.push(label.id);
    groupsHandled += 1;
  }

  if (!toDelete.length) {
    toast('沒有「同時有 PDF 與 .wdfx」的標籤需要處理');
    return;
  }
  const message = `每一組只保留 .wdfx，刪除 ${toDelete.length} 個 PDF（共 ${groupsHandled} 組）？`
    + (transfers.length ? `\n其中 ${transfers.length} 筆配對會先轉移到 .wdfx。` : '')
    + '\n雲端的 PDF 檔案也會一併刪除，無法復原。';
  if (!confirm(message)) return;

  for (const { from, to } of transfers) await transferMatch(from, to);
  const removed = await deleteLabels(toDelete, { silent: true });
  const { pdfWithoutTwin } = formatSummary();
  toast(`已刪除 ${removed} 個 PDF${transfers.length ? `，轉移 ${transfers.length} 筆配對` : ''}`);
  showStatus('pdfStatus', `已刪除 ${removed} 個 PDF；還有 ${pdfWithoutTwin.length} 個 PDF 沒有 .wdfx 版本${pdfWithoutTwin.length ? '（如也要刪除，按「刪除所有 PDF」）' : ''}`, 'warn');
}

async function deleteAllPdf() {
  const { pdf, pdfWithoutTwin } = formatSummary();
  if (!pdf.length) {
    toast('目前沒有 PDF 標籤');
    return;
  }
  const base = `刪除全部 ${pdf.length} 個 PDF 標籤？雲端檔案也會一併刪除，無法復原。`;
  if (!confirm(base)) return;
  if (pdfWithoutTwin.length) {
    const warning = `注意：其中 ${pdfWithoutTwin.length} 個 PDF「沒有 .wdfx 版本」，刪除後就完全沒有檔案了。\n仍要繼續嗎？`;
    if (!confirm(warning)) return;
  }
  const removed = await deleteLabels(pdf.map(label => label.id), { silent: true });
  toast(`已刪除 ${removed} 個 PDF`);
  showStatus('pdfStatus', `已刪除 ${removed} 個 PDF 標籤；目前標籤 ${Object.keys(state.labels).length} 筆`, 'warn');
}

/* ------------------------------------------------- 清除雲端資料（危險操作） */

function openClearCloudModal() {
  if (!state.cloudEnabled) {
    toast('雲端未連線，無法清除雲端資料');
    return;
  }
  const labels = Object.keys(state.labels).length;
  const products = state.products.length;
  $('clearCloudCounts').innerHTML = `目前雲端（以畫面上的資料估算）：<b>${labels.toLocaleString()}</b> 個標籤、`
    + `<b>${products.toLocaleString()}</b> 個商品。`;
  $('clearCloudConfirmInput').value = '';
  $('clearCloudConfirmBtn').disabled = true;
  document.querySelector('input[name="clearScope"][value="labels"]').checked = true;
  $('clearCloudModal').classList.add('show');
}

function closeClearCloudModal() {
  $('clearCloudModal').classList.remove('show');
  $('clearCloudConfirmInput').value = '';
}

function currentClearScope() {
  const checked = document.querySelector('input[name="clearScope"]:checked');
  return checked ? checked.value : 'labels';
}

async function runClearCloud() {
  const scope = currentClearScope();
  const typed = $('clearCloudConfirmInput').value.trim();
  if (typed !== '清除') {
    toast('請先輸入「清除」兩個字');
    return;
  }
  const scopeText = scope === 'labels' ? '所有標籤與 PDF（商品保留）'
    : scope === 'products' ? '所有商品（標籤與 PDF 保留）'
      : '標籤、PDF 與商品（全部）';
  if (!confirm(`確定要清除${scopeText}？此動作無法復原。`)) return;

  const button = $('clearCloudConfirmBtn');
  button.disabled = true;
  button.textContent = '清除中…';
  try {
    const result = await api.clearCloud({ scope, confirm: typed });

    // 本機一起清，避免下次同步又把舊資料傳回去
    if (scope === 'labels' || scope === 'all') {
      try {
        await db.clearLabels();
        await db.clearBlobs();
      } catch (err) { console.warn('[clear] 本機標籤清除失敗', err); }
      state.labels = {};
      state.selectedLabelIds.clear();
      for (const product of state.products) product.labelId = null;
    }
    if (scope === 'products' || scope === 'all') {
      try { await db.clearProducts(); } catch (err) { console.warn('[clear] 本機商品清除失敗', err); }
      state.products = [];
      state.remoteProducts = null;
    }
    try {
      pipeline.setProducts(state.products);
      pipeline.setLabels(state.labels);
      matcher.setProducts(state.products);
      matcher.setManualLabelIds(manualLabelIdSet());
    } catch { /* ignore */ }
    updateStats();
    renderMatchList();
    closeClearCloudModal();

    toast(`已清除：標籤 ${result.deletedLabels || 0}、商品 ${result.deletedProducts || 0}、檔案 ${result.deletedObjects || 0}`);
    showStatus('cloudStatus', `雲端資料已清除（標籤 ${result.deletedLabels || 0}、商品 ${result.deletedProducts || 0}、R2 檔案 ${result.deletedObjects || 0}）`, 'warn');
    if (window.app && typeof window.app.reloadCloud === 'function') window.app.reloadCloud();
  } catch (err) {
    toast(`清除失敗：${err.message}`);
    showStatus('cloudStatus', `清除失敗：${err.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '確定清除';
  }
}

/* ------------------------------------------------------- 編輯標籤視窗 */

function openEditLabelModal(id) {
  const label = state.labels[id];
  if (!label) return;
  state.editingLabelId = id;
  $('editLabelOrig').textContent = `原始檔名：${label.filename || '（無）'}`;
  $('editLabelNameInput').value = label.nameFromFile || label.filename || '';
  const info = $('editLabelMatchInfo');
  info.textContent = label.matchedProductName
    ? `目前配對：${label.matchedProductName}${label.matchSource === 'manual' ? '（人工）' : '（自動）'}`
    : '目前尚未配對任何商品';
  $('editLabelModal').classList.add('show');
}

function closeEditLabelModal() {
  $('editLabelModal').classList.remove('show');
  state.editingLabelId = null;
}

function renderMatchList() {
  const el = $('matchList');
  if (!el) return;
  const all = Object.values(state.labels).map(label => ({ ...label }));
  const dups = duplicateMap(all);
  const dupExtras = extraDuplicateIds(all);

  const passesFilter = l => {
    switch (state.matchFilter) {
      case 'matched': return Boolean(l.matchedProductName);
      case 'review': return l.matchConfidence === 'review';
      case 'unmatched': return !l.matchedProductName && !l.deferred;
      case 'deferred': return Boolean(l.deferred);
      case 'dup': return dups.has(l.id);
      default: return true;
    }
  };
  const filtered = all
    .filter(passesFilter)
    .filter(l => {
      if (!state.matchQuery) return true;
      const q = normalize(state.matchQuery);
      return normalize(`${l.nameFromFile || ''} ${l.matchedProductName || ''}`).includes(q);
    });

  filtered.sort((a, b) => {
    // 「稍後處理」的標籤一律壓到最後
    const byDefer = Number(Boolean(a.deferred)) - Number(Boolean(b.deferred));
    if (byDefer !== 0 && state.matchSort !== 'deferred') return byDefer;
    if (state.matchFilter === 'dup') {
      // 同一組重複要排在一起，方便一眼比較
      const byGroup = labelDupKey(a).localeCompare(labelDupKey(b));
      if (byGroup !== 0) return byGroup;
    }
    return state.matchSort === 'name'
      ? normalize(a.nameFromFile).localeCompare(normalize(b.nameFromFile), 'zh-Hant')
      : state.matchSort === 'newest'
        ? String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
        : Number(!a.matchedProductName) - Number(!b.matchedProductName);
  });

  const visibleIds = new Set(filtered.map(l => l.id));
  for (const id of [...state.selectedLabelIds]) if (!visibleIds.has(id)) state.selectedLabelIds.delete(id);

  const formatInfo = $('formatInfo');
  if (formatInfo) {
    const labels = Object.values(state.labels);
    const pdfCount = labels.filter(label => formatOf(label) === 'pdf').length;
    const wdfxCount = labels.filter(label => formatOf(label) === 'wdfx').length;
    const otherCount = labels.length - pdfCount - wdfxCount;
    formatInfo.textContent = labels.length
      ? `格式：PDF ${pdfCount} 個 · WDFX ${wdfxCount} 個${otherCount ? ` · 其他 ${otherCount} 個` : ''}`
      : '';
    const wdfxBtn = $('keepWdfxBtn');
    const pdfBtn = $('deletePdfBtn');
    if (wdfxBtn) wdfxBtn.disabled = !pdfCount;
    if (pdfBtn) pdfBtn.disabled = !pdfCount;
  }

  const dupGroups = new Set([...dups.keys()].map(id => labelDupKey(state.labels[id] || {}))).size;
  const deferredTotal = all.filter(x => x.deferred).length;
  const deferredCountEl = $('deferredCount');
  if (deferredCountEl) deferredCountEl.textContent = String(deferredTotal);
  $('matchSummary').textContent = `顯示 ${filtered.length} / ${all.length} 個標籤 · 已配對 ${all.filter(x => x.matchedProductName).length}`
    + ` · 待確認 ${all.filter(x => x.matchConfidence === 'review').length}`
    + ` · 未配對 ${all.filter(x => !x.matchedProductName && !x.deferred).length}`
    + (deferredTotal ? ` · 已延後 ${deferredTotal}` : '')
    + (dupExtras.length ? ` · 重複 ${dupGroups} 組（多出 ${dupExtras.length} 筆）` : '');

  const dupCountEl = $('dupCount');
  if (dupCountEl) dupCountEl.textContent = String(dupExtras.length);
  const banner = $('dupBanner');
  if (banner) {
    const text = $('dupBannerText');
    if (dupExtras.length && state.matchFilter !== 'dup') {
      banner.style.display = '';
      const sameContent = [...dups.values()].filter(info => info.type === 'content').length;
      const sameName = [...dups.values()].filter(info => info.type === 'name').length;
      if (text) text.innerHTML = `🔁 發現 <b>${dupGroups}</b> 組重複，共 <b>${dupExtras.length}</b> 筆是多餘的`
        + `（內容完全相同 ${sameContent} 筆、同名不同檔 ${sameName} 筆，例如 PDF 與轉檔後的 .wdfx）。`
        + '<br>「同名不同檔」請用每一筆的「保留這筆」決定要留哪個格式，再按「每組只留一筆」會依〔人工配對 → 已配對 → 最新上傳〕自動選。';
    } else if (!dupExtras.length) {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'none';
    }
  }

  if (!filtered.length) {
    el.innerHTML = '<div class="empty"><div class="icon">📄</div>沒有符合條件的項目</div>';
    updateSelectionUI([]);
    return;
  }

  const shown = filtered.slice(0, state.renderLimit);
  el.innerHTML = shown.map(l => {
    const linked = l.matchedProductName;
    const manual = l.matchSource === 'manual';
    const selected = state.selectedLabelIds.has(l.id);
    return `<div class="label-item${selected ? ' is-selected' : ''}">
      <div class="label-top">
        <label class="label-check" aria-label="選取此標籤"><input class="match-check" type="checkbox" data-label-id="${escapeHtml(l.id)}" ${selected ? 'checked' : ''}></label>
        <div class="fname">${escapeHtml(l.nameFromFile || l.filename)}</div>
      </div>
      <div class="meta">
        ${linked ? `<span class="tag-ok">已配對：${escapeHtml(linked)}</span>` : '<span class="tag-no">未配對</span>'}
        ${manual ? '<span class="tag-warn">人工鎖定</span>' : ''}
        ${l.matchConfidence === 'review' ? '<span class="tag-warn">待確認</span>' : ''}
        ${l.deferred ? '<span class="tag-warn">⏳ 已延後</span>' : ''}
        ${l.hasLocalBlob ? '<span class="tag-offline">本機可離線</span>' : (l.uploaded ? '<span class="tag-offline">雲端</span>' : '')}
        ${(() => { const kind = labelKind(l); const ext = (l.ext || extFromName(l.filename) || '').toUpperCase();
          if (kind === 'pdf' || !ext) return '';
          return `<span class="tag-warn">${escapeHtml(ext)}${kind === 'image' ? '（可預覽）' : '（不支援預覽）'}</span>`; })()}
        ${l.matchScore && !manual ? `<span>信心 ${l.matchScore}${l.matchGap != null ? ` · 差距 ${l.matchGap}` : ''}</span>` : ''}
      </div>
      ${dups.get(l.id) ? `<div><span class="tag-dup">${dups.get(l.id).type === 'content' ? '重複' : '同名'} ×${dups.get(l.id).size}</span></div>` : ''}
      ${l.matchWhy && !manual ? `<div class="score-note">判斷依據：${escapeHtml(l.matchWhy)}</div>` : ''}
      <div class="label-actions">
        ${linked
          ? `<button class="btn btn-outline btn-sm" data-action="unlink" data-id="${escapeHtml(l.id)}">解除配對</button>
             <button class="btn btn-primary btn-sm" data-action="match" data-id="${escapeHtml(l.id)}">重新配對</button>`
          : `<button class="btn btn-primary btn-sm" data-action="match" data-id="${escapeHtml(l.id)}">手動配對</button>`}
        <button class="btn btn-outline btn-sm" data-action="preview" data-id="${escapeHtml(l.id)}">預覽</button>
        <button class="btn btn-outline btn-sm" data-action="${l.deferred ? 'undefer' : 'defer'}" data-id="${escapeHtml(l.id)}">${l.deferred ? '↩️ 取消延後' : '⏳ 稍後處理'}</button>
        <button class="btn btn-outline btn-sm" data-action="edit" data-id="${escapeHtml(l.id)}">✏️ 編輯</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(l.id)}">刪除</button>
        ${dups.get(l.id) ? `<button class="btn btn-primary btn-sm" data-action="keep" data-id="${escapeHtml(l.id)}">保留這筆，刪除其他 ${dups.get(l.id).size - 1} 筆</button>` : ''}
      </div>
    </div>`;
  }).join('');

  if (filtered.length > shown.length) {
    const more = document.createElement('button');
    more.className = 'btn btn-outline more-btn';
    more.textContent = `顯示更多（還有 ${filtered.length - shown.length} 個）`;
    more.addEventListener('click', () => {
      state.renderLimit += 100;
      renderMatchList();
    });
    el.appendChild(more);
  }
  updateSelectionUI(shown.map(l => l.id));
}

function updateSelectionUI(visibleIds = []) {
  const count = state.selectedLabelIds.size;
  const countEl = $('selectedCount');
  if (countEl) countEl.textContent = `已選 ${count} 項`;
  const select = $('selectVisibleBtn');
  if (select) {
    select.checked = visibleIds.length > 0 && visibleIds.every(id => state.selectedLabelIds.has(id));
    select.indeterminate = count > 0 && !select.checked;
  }
  const clear = $('clearSelectionBtn');
  if (clear) clear.disabled = count === 0;
}

function updateStats() {
  $('statProducts').textContent = state.products.length;
  $('statLabels').textContent = Object.keys(state.labels).length;
  $('statMatched').textContent = Object.values(state.labels).filter(l => l.matchedProductName).length;
  const usage = $('storageInfo');
  if (usage) {
    db.storageEstimate().then(estimate => {
      if (!estimate || !estimate.quota) {
        usage.textContent = '';
        return;
      }
      usage.textContent = `本機已用 ${formatBytes(estimate.usage || 0)} / 可用約 ${formatBytes(estimate.quota || 0)}`;
    }).catch(() => {});
  }
}

/* ---------------------------------------------------------- 手動配對視窗 */

let modalProductCache = [];
let modalSearchTimer = null;

function renderModalProducts(list) {
  const el = $('modalProductList');
  if (!list.length) {
    el.innerHTML = '<div class="empty">找不到商品</div>';
    return;
  }
  el.innerHTML = list.slice(0, 40).map(p => `
    <div class="picker-row">
      <div>
        <div class="picker-name">${escapeHtml(p.name)}</div>
        <div class="picker-meta">${escapeHtml(p.barcode || '')}${p.barcode2 ? ` / ${escapeHtml(p.barcode2)}` : ''}</div>
      </div>
      <button class="btn btn-primary btn-sm" data-pick="${escapeHtml(String(p.id))}">選擇</button>
    </div>`).join('');
}

function openMatchModal(id) {
  const label = state.labels[id];
  if (!label) return;
  state.currentMatchLabelId = id;
  $('modalLabelName').textContent = `為「${label.nameFromFile || label.filename}」選擇商品`;
  $('modalSearchInput').value = '';
  modalProductCache = state.products.slice(0, 40);
  renderModalProducts(modalProductCache);
  $('matchModal').classList.add('show');
}

function closeMatchModal() {
  $('matchModal').classList.remove('show');
  state.currentMatchLabelId = null;
}

async function persistLabelEverywhere(label) {
  await db.putLabel(label);
  if (state.cloudEnabled && label.uploaded) {
    try {
      await api.patchLabel(label.id, {
        productId: label.productId ?? null,
        matchedProductName: label.matchedProductName || null,
        matchSource: label.matchSource || null,
        matchScore: label.matchScore ?? null,
        matchConfidence: label.matchConfidence || null,
        matchGap: label.matchGap ?? null,
        matchWhy: label.matchWhy || null
      });
    } catch (err) {
      toast(`已存本機，雲端同步稍後重試：${err.message}`);
    }
  }
}

async function confirmMatch(productId) {
  const label = state.labels[state.currentMatchLabelId];
  const product = state.products.find(p => p.id === productId);
  if (!label || !product) return;
  for (const p of state.products) if (p.labelId === label.id) p.labelId = null;
  product.labelId = label.id;
  label.productId = product.id;
  label.matchedProductName = product.name;
  label.matchSource = 'manual';
  label.matchConfidence = 'high';
  label.matchScore = null;
  label.matchGap = null;
  label.matchWhy = '人工配對';
  label.updatedAt = nowISO();
  closeMatchModal();
  await persistLabelEverywhere(label);
  await db.putProducts([product]);
  matcher.setManualLabelIds(manualLabelIdSet());
  updateStats();
  renderMatchList();
  toast(`已配對：${product.name}`);
}

async function unlinkLabel(id) {
  const label = state.labels[id];
  if (!label) return;
  const cleared = [];
  for (const p of state.products) {
    if (p.labelId === id) {
      p.labelId = null;
      cleared.push(p);
    }
  }
  label.matchedProductName = null;
  label.matchSource = null;
  label.matchScore = null;
  label.matchConfidence = null;
  label.matchGap = null;
  label.matchWhy = null;
  label.productId = null;
  label.updatedAt = nowISO();
  await persistLabelEverywhere(label);
  if (cleared.length) await db.putProducts(cleared);
  matcher.setManualLabelIds(manualLabelIdSet());
  updateStats();
  renderMatchList();
  toast('已解除配對');
}

/* -------------------------------------------------------------- 取得 PDF */

async function getLabelBlob(label) {
  if (!label) throw new Error('找不到標籤');
  if (state.blobCache.has(label.id)) return state.blobCache.get(label.id);
  let blob = null;
  if (label.hash) {
    const record = await db.getBlobRecord(label.hash);
    if (record && record.blob) blob = record.blob;
  }
  if (!blob && (label.uploaded || label.remote)) {
    const response = await fetch(api.labelFileUrl(label.id), { cache: 'no-store' });
    if (!response.ok) throw new Error('無法從雲端下載 PDF');
    blob = await response.blob();
  }
  if (!blob) throw new Error('此標籤沒有可用的 PDF（本機與雲端都沒有）');
  // 只保留最近 3 個在記憶體，避免 iPhone 記憶體爆掉
  if (state.blobCache.size >= 3) state.blobCache.delete(state.blobCache.keys().next().value);
  state.blobCache.set(label.id, blob);
  return blob;
}

function asFile(blob, name, type) {
  return new File([blob], name || 'label.pdf', { type: type || 'application/pdf' });
}

function labelMime(label) {
  if (label && label.mime) return label.mime;
  const kind = label && label.kind ? label.kind : 'pdf';
  return kind === 'pdf' ? 'application/pdf' : 'application/octet-stream';
}

function fallbackDownload(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已下載，請手動分享到 WePrint');
}

async function shareLabel(id) {
  const label = state.labels[id];
  if (!label) {
    toast('找不到標籤資料');
    return;
  }
  try {
    const blob = await getLabelBlob(label);
    const file = asFile(blob, label.filename || `label.${label.ext || 'pdf'}`, labelMime(label));
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ files: [file], title: label.nameFromFile || label.filename, text: '營養標籤' });
      toast('已開啟分享選單');
    } else {
      fallbackDownload(file);
    }
  } catch (err) {
    toast(`找不到標籤檔案：${err.message}`);
  }
}

/* -------------------------------------------------------------- PDF 預覽 */

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  try {
    const module = await import('../vendor/pdfjs/pdf.min.mjs');
    module.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
    window.pdfjsLib = module;
    return module;
  } catch (err) {
    console.error('PDF.js 載入失敗', err);
    return null;
  }
}

async function renderPreviewPage() {
  const { pdf, page } = state.preview;
  if (!pdf) return;
  const stage = $('previewStage');
  stage.innerHTML = `<div class="preview-loading">載入第 ${page} 頁…</div>`;
  try {
    const pageObj = await pdf.getPage(page);
    const viewport = pageObj.getViewport({ scale: 1.35 });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.maxWidth = '100%';
    await pageObj.render({ canvasContext: canvas.getContext('2d'), viewport: pageObj.getViewport({ scale: 1.35 * ratio }) }).promise;
    stage.innerHTML = '';
    stage.appendChild(canvas);
    $('pageInfo').textContent = `第 ${page} / ${pdf.numPages} 頁`;
    $('prevPageBtn').disabled = page <= 1;
    $('nextPageBtn').disabled = page >= pdf.numPages;
  } catch (err) {
    stage.innerHTML = '<div class="preview-loading">此 PDF 無法在內嵌預覽，請使用「在系統開啟」或下載。</div>';
  }
}

async function previewLabel(id) {
  const label = state.labels[id];
  if (!label) {
    toast('找不到標籤資料');
    return;
  }
  try {
    const blob = await getLabelBlob(label);
    closePreview();
    state.preview.labelId = id;
    state.preview.url = URL.createObjectURL(blob);
    state.preview.page = 1;
    state.preview.pdf = null;
    $('previewTitle').textContent = label.nameFromFile || label.filename || '標籤預覽';
    $('previewStage').innerHTML = '<div class="preview-loading">準備預覽中…</div>';
    $('previewModal').classList.add('show');

    const kind = labelKind(label);

    if (kind === 'image') {
      closePdfPreviewOnly();
      $('previewStage').innerHTML = `<img src="${state.preview.url}" alt="${escapeHtml(label.nameFromFile || '')}"
        style="max-width:100%;max-height:70dvh;object-fit:contain;border-radius:8px">`;
      return;
    }

    if (kind !== 'pdf') {
      // .wdfx 這類「WePrint 讀得到、但不是 PDF」的檔案：不在站內預覽，但可以直接分享或下載
      closePdfPreviewOnly();
      $('previewStage').innerHTML = `
        <div class="preview-loading">
          <div style="font-size:2rem">📄</div>
          <p><strong>${escapeHtml((label.ext || '').toUpperCase() || '此格式')}</strong> 無法在網站內預覽。</p>
          <p style="font-size:.82rem;color:#64748b">檔案已完整保存，可直接用下面的「分享到 WePrint」或「下載」使用。</p>
        </div>`;
      return;
    }

    const pdfjs = await loadPdfJs();
    if (!pdfjs) {
      $('previewStage').innerHTML = '<div class="preview-loading">預覽元件載入失敗，請使用「在系統開啟」或下載。</div>';
      return;
    }
    state.preview.pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    await renderPreviewPage();
  } catch (err) {
    toast(`無法取得標籤檔案：${err.message}`);
  }
}

// 只清掉 PDF.js 的部分（圖片／其他格式沒有 PDF 物件，但仍要清空預覽區）
function closePdfPreviewOnly() {
  if (state.preview.pdf) {
    try { state.preview.pdf.destroy(); } catch { /* ignore */ }
  }
  state.preview.pdf = null;
  const stage = $('previewStage');
  if (stage) stage.innerHTML = '';
  const pageInfo = $('pageInfo');
  if (pageInfo) pageInfo.textContent = '—';
  if ($('prevPageBtn')) $('prevPageBtn').disabled = true;
  if ($('nextPageBtn')) $('nextPageBtn').disabled = true;
}

function closePreview() {
  $('previewModal').classList.remove('show');
  const stage = $('previewStage');
  if (stage) stage.innerHTML = '';
  if (state.preview.pdf) {
    try { state.preview.pdf.destroy(); } catch { /* ignore */ }
  }
  state.preview.pdf = null;
  if (state.preview.url) URL.revokeObjectURL(state.preview.url);
  state.preview.url = null;
  state.preview.labelId = null;
}

/* ----------------------------------------------------------------- 搜尋 */

let searchSeq = 0;

async function doSearch(query) {
  const q = String(query || '').trim();
  const el = $('searchResults');
  if (!q) {
    el.innerHTML = '<div class="empty"><div class="icon">🔎</div>請輸入尾 6 碼或商品名稱</div>';
    return;
  }
  if (!state.products.length) {
    el.innerHTML = '<div class="empty"><div class="icon">📭</div>請先上傳 Excel</div>';
    return;
  }
  const barcodeQuery = isBarcodeQuery(q);
  if (barcodeQuery && digits(q).length < 6) {
    el.innerHTML = '<div class="empty"><div class="icon">🔢</div>條碼搜尋請輸入完整尾 6 碼</div>';
    return;
  }
  const seq = ++searchSeq;
  el.innerHTML = '<div class="empty">搜尋中…</div>';
  let results;
  if (barcodeQuery) {
    const tail = barcodeTail6(q);
    results = state.products.filter(p => barcodeMatchesTail(p, tail));
  } else {
    results = await matcher.search(q, 10);
  }
  if (seq !== searchSeq) return;

  if (!results.length) {
    el.innerHTML = `<div class="empty"><div class="icon">😕</div>${barcodeQuery ? `找不到條碼尾 6 碼「${escapeHtml(barcodeTail6(q))}」的商品` : '找不到符合的商品'}</div>`;
    return;
  }
  el.innerHTML = results.map(p => {
    const label = p.labelId ? state.labels[p.labelId] : null;
    const tailCodes = [p.barcode, p.barcode2].map(barcodeTail6).filter((code, i, arr) => code && arr.indexOf(code) === i);
    return `<div class="result-card">
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="meta">
        ${tailCodes.length ? `<span>條碼尾 6 碼：${escapeHtml(tailCodes.join(' / '))}</span>` : ''}
        ${label ? '<span class="tag-ok">已有標籤</span>' : '<span class="tag-no">未配對標籤</span>'}
      </div>
      <div class="result-actions">
        ${label
          ? `<button class="btn btn-primary" data-action="share" data-id="${escapeHtml(label.id)}">📤 分享到 WePrint</button>
             <button class="btn btn-outline" data-action="preview" data-id="${escapeHtml(label.id)}">👁 預覽</button>`
          : '<button class="btn btn-outline" disabled>尚無標籤</button>'}
      </div>
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------------ 事件 */

function bindEvents() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'match') renderMatchList();
      if (tab.dataset.tab !== 'search') stopScanner();
    });
  });

  $('pdfInput').addEventListener('change', async event => {
    const input = event.target;
    const files = input.files;
    // 先複製成陣列再清空 input：iOS Safari 在 input.value='' 之後會釋放 File 參照
    const list = Array.from(files || []);
    input.value = '';
    await handlePdfSelection(list);
  });

  // 資料夾選取（iOS 檔案 App 可整個資料夾）
  const dirInput = $('pdfDirInput');
  if (dirInput) {
    dirInput.addEventListener('change', async event => {
      const list = Array.from(event.target.files || []);
      event.target.value = '';
      await handlePdfSelection(list);
    });
  }

  $('excelInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importExcel(file);
    } catch (err) {
      showStatus('excelStatus', `讀取失敗：${err.message}`, 'error');
    }
  });

  $('syncCloudBtn').addEventListener('click', syncAllToCloud);

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.matchFilter = btn.dataset.filter;
      state.renderLimit = 60;
      renderMatchList();
    });
  });

  $('matchSearchInput').addEventListener('input', event => {
    state.matchQuery = event.target.value;
    state.renderLimit = 60;
    renderMatchList();
  });
  $('matchSort').addEventListener('change', event => {
    state.matchSort = event.target.value;
    renderMatchList();
  });

  $('matchList').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (button) {
      const { action, id } = button.dataset;
      if (action === 'preview') previewLabel(id);
      else if (action === 'match') openMatchModal(id);
      else if (action === 'unlink') unlinkLabel(id);
      else if (action === 'defer') { setDeferred([id], true).then(() => toast('已移到清單最後面')); }
      else if (action === 'undefer') { setDeferred([id], false).then(() => toast('已移回清單')); }
      else if (action === 'edit') openEditLabelModal(id);
      else if (action === 'delete') {
        const label = state.labels[id];
        const name = label ? (label.nameFromFile || label.filename) : id;
        if (confirm(`刪除標籤「${name}」？\n雲端的 PDF 檔案也會一起刪除，無法復原。`)) deleteLabels([id]);
      } else if (action === 'keep') {
        const label = state.labels[id];
        if (!label) return;
        // 同名的（例如同一張標籤的 pdf 與 wdfx）優先；沒有同名才退回同內容
        const nameKey = labelNameKey(label);
        const sameName = Object.values(state.labels)
          .filter(other => other.id !== id && labelNameKey(other) === nameKey);
        const others = (sameName.length
          ? sameName
          : Object.values(state.labels).filter(other => other.id !== id && label.hash && other.hash === label.hash)
        ).map(other => other.id);
        if (!others.length) {
          toast('這個標籤沒有其他重複項目了');
          return;
        }
        if (confirm(`保留「${label.nameFromFile || label.filename}」，刪除其他 ${others.length} 筆相同內容的標籤？`)) {
          deleteLabels(others);
        }
      }
      return;
    }
  });
  $('matchList').addEventListener('change', event => {
    const input = event.target.closest('input.match-check');
    if (!input) return;
    if (input.checked) state.selectedLabelIds.add(input.dataset.labelId);
    else state.selectedLabelIds.delete(input.dataset.labelId);
    input.closest('.label-item').classList.toggle('is-selected', input.checked);
    updateSelectionUI([...document.querySelectorAll('input.match-check')].map(x => x.dataset.labelId));
  });

  $('selectVisibleBtn').addEventListener('change', event => {
    document.querySelectorAll('input.match-check').forEach(input => {
      if (event.target.checked) state.selectedLabelIds.add(input.dataset.labelId);
      else state.selectedLabelIds.delete(input.dataset.labelId);
    });
    renderMatchList();
  });
  $('clearSelectionBtn').addEventListener('click', () => {
    state.selectedLabelIds.clear();
    renderMatchList();
  });

  $('bulkRematchBtn').addEventListener('click', async () => {
    const ids = [...state.selectedLabelIds];
    if (!ids.length) {
      toast('請先勾選要重新配對的項目');
      return;
    }
    if (!state.products.length) {
      toast('請先上傳 Excel 商品資料');
      return;
    }
    let changed = 0;
    let skipped = 0;
    const batch = [];
    for (const id of ids) {
      const label = state.labels[id];
      if (!label) continue;
      if (label.matchSource === 'manual') {
        skipped++;
        continue;
      }
      batch.push(label);
    }
    showStatus('pdfStatus', `重新配對 ${batch.length} 項…`);
    for (let i = 0; i < batch.length; i += 20) {
      const slice = batch.slice(i, i + 20);
      const items = slice.map(l => ({ key: l.id, name: l.nameFromFile || l.filename, labelId: l.id }));
      const results = await matcher.matchBatch(items);
      const byKey = new Map(results.map(r => [r.key, r.result]));
      const updates = [];
      for (const label of slice) {
        const result = byKey.get(label.id);
        for (const p of state.products) if (p.labelId === label.id) p.labelId = null;
        if (result && result.confidence !== 'low') {
          const product = state.products.find(p => p.id === result.productId);
          if (product) {
            product.labelId = label.id;
            label.productId = product.id;
            label.matchedProductName = product.name;
            label.matchSource = 'auto';
            label.matchScore = result.score;
            label.matchConfidence = result.confidence;
            label.matchGap = result.gap;
            label.matchWhy = (result.why || []).join('、');
          }
          changed++;
        } else {
          label.productId = null;
          label.matchedProductName = null;
          label.matchSource = null;
          label.matchScore = null;
          label.matchConfidence = 'low';
          label.matchGap = null;
          label.matchWhy = null;
        }
        label.updatedAt = nowISO();
        updates.push(label);
      }
      await db.putLabels(updates);
      await yieldMain();
    }
    await db.putProducts(state.products);
    state.selectedLabelIds.clear();
    matcher.setManualLabelIds(manualLabelIdSet());
    updateStats();
    renderMatchList();
    if (state.cloudEnabled) await syncMatchMetadata();
    showStatus('pdfStatus', `已重新配對 ${changed} 項${skipped ? `；跳過人工鎖定 ${skipped} 項` : ''}`);
    toast(`已重新配對 ${changed} 項`);
  });

  $('bulkDeleteBtn').addEventListener('click', async () => {
    const ids = [...state.selectedLabelIds];
    if (!ids.length) {
      toast('請先勾選要刪除的標籤');
      return;
    }
    if (!confirm(`刪除所選 ${ids.length} 個標籤？\n雲端的 PDF 檔案也會一起刪除，無法復原。`)) return;
    await deleteLabels(ids);
  });

  $('dupKeepOneBtn').addEventListener('click', async () => {
    const extras = extraDuplicateIds(Object.values(state.labels));
    if (!extras.length) {
      toast('目前沒有重複的標籤');
      return;
    }
    if (!confirm(`每組重複只保留 1 筆（人工配對優先、其次最新上傳），刪除其他 ${extras.length} 筆？\n雲端 PDF 也會一併刪除。`)) return;
    const removed = await deleteLabels(extras);
    toast(`已刪除 ${removed} 筆重複標籤`);
  });

  $('dupSelectAllBtn').addEventListener('click', () => {
    const extras = extraDuplicateIds(Object.values(state.labels));
    for (const id of extras) state.selectedLabelIds.add(id);
    state.matchFilter = 'dup';
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === 'dup');
    });
    state.renderLimit = Math.max(state.renderLimit, extras.length + 10);
    renderMatchList();
    toast(`已勾選 ${extras.length} 筆多餘的重複標籤`);
  });

  /* 稍後處理 */
  if ($('bulkDeferBtn')) $('bulkDeferBtn').addEventListener('click', () => deferSelected(true));
  if ($('bulkUndeferBtn')) $('bulkUndeferBtn').addEventListener('click', () => deferSelected(false));

  /* 格式管理 */
  if ($('keepWdfxBtn')) $('keepWdfxBtn').addEventListener('click', keepOnlyWdfx);
  if ($('deletePdfBtn')) $('deletePdfBtn').addEventListener('click', deleteAllPdf);

  /* 清除雲端資料 */
  if ($('clearCloudBtn')) $('clearCloudBtn').addEventListener('click', openClearCloudModal);
  if ($('clearCloudCancelBtn')) $('clearCloudCancelBtn').addEventListener('click', closeClearCloudModal);
  if ($('clearCloudConfirmBtn')) $('clearCloudConfirmBtn').addEventListener('click', runClearCloud);
  if ($('clearCloudConfirmInput')) {
    $('clearCloudConfirmInput').addEventListener('input', event => {
      $('clearCloudConfirmBtn').disabled = event.target.value.trim() !== '清除';
    });
  }
  if ($('clearCloudModal')) {
    $('clearCloudModal').addEventListener('click', event => {
      if (event.target === $('clearCloudModal')) closeClearCloudModal();
    });
  }

  /* 編輯標籤視窗 */
  $('editLabelSaveBtn').addEventListener('click', async () => {
    const id = state.editingLabelId;
    if (!id) return;
    const ok = await renameLabel(id, $('editLabelNameInput').value);
    if (ok) closeEditLabelModal();
  });
  $('editLabelPickBtn').addEventListener('click', () => {
    const id = state.editingLabelId;
    if (!id) return;
    closeEditLabelModal();
    openMatchModal(id);
  });
  $('editLabelDeleteBtn').addEventListener('click', async () => {
    const id = state.editingLabelId;
    if (!id) return;
    const label = state.labels[id];
    if (!confirm(`刪除標籤「${label ? (label.nameFromFile || label.filename) : id}」？雲端 PDF 也會刪除。`)) return;
    closeEditLabelModal();
    await deleteLabels([id]);
  });
  $('editLabelCloseBtn').addEventListener('click', closeEditLabelModal);
  $('editLabelModal').addEventListener('click', event => {
    if (event.target === $('editLabelModal')) closeEditLabelModal();
  });

  $('bulkUnlinkBtn').addEventListener('click', async () => {
    const ids = [...state.selectedLabelIds];
    if (!ids.length) {
      toast('請先勾選要解除的項目');
      return;
    }
    if (!confirm(`確定解除所選 ${ids.length} 個標籤的配對？`)) return;
    const updates = [];
    for (const id of ids) {
      const label = state.labels[id];
      if (!label) continue;
      for (const p of state.products) if (p.labelId === id) p.labelId = null;
      label.productId = null;
      label.matchedProductName = null;
      label.matchSource = null;
      label.matchScore = null;
      label.matchConfidence = null;
      label.matchGap = null;
      label.matchWhy = null;
      label.updatedAt = nowISO();
      updates.push(label);
    }
    await db.putLabels(updates);
    await db.putProducts(state.products);
    state.selectedLabelIds.clear();
    matcher.setManualLabelIds(manualLabelIdSet());
    updateStats();
    renderMatchList();
    if (state.cloudEnabled) await syncMatchMetadata();
    toast(`已解除 ${ids.length} 項配對`);
  });

  // 手動配對視窗
  $('modalSearchInput').addEventListener('input', event => {
    const q = event.target.value;
    clearTimeout(modalSearchTimer);
    modalSearchTimer = setTimeout(async () => {
      if (!q.trim()) {
        renderModalProducts(state.products.slice(0, 40));
        return;
      }
      renderModalProducts(await matcher.search(q, 40));
    }, 180);
  });
  $('modalProductList').addEventListener('click', event => {
    const button = event.target.closest('button[data-pick]');
    if (button) confirmMatch(Number(button.dataset.pick));
  });
  $('modalCloseBtn').addEventListener('click', closeMatchModal);
  $('matchModal').addEventListener('click', event => {
    if (event.target === $('matchModal')) closeMatchModal();
  });

  // 搜尋頁
  $('searchBtn').addEventListener('click', () => doSearch($('barcodeInput').value));
  $('barcodeInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') doSearch(event.target.value);
  });
  $('searchResults').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'share') shareLabel(button.dataset.id);
    if (button.dataset.action === 'preview') previewLabel(button.dataset.id);
  });

  // 預覽視窗
  $('previewCloseBtn').addEventListener('click', closePreview);
  $('previewModal').addEventListener('click', event => {
    if (event.target === $('previewModal')) closePreview();
  });
  $('prevPageBtn').addEventListener('click', async () => {
    if (state.preview.page > 1) {
      state.preview.page--;
      await renderPreviewPage();
    }
  });
  $('nextPageBtn').addEventListener('click', async () => {
    if (state.preview.pdf && state.preview.page < state.preview.pdf.numPages) {
      state.preview.page++;
      await renderPreviewPage();
    }
  });
  $('previewShareBtn').addEventListener('click', () => {
    const id = state.preview.labelId;
    closePreview();
    if (id) shareLabel(id);
  });
  $('previewOpenBtn').addEventListener('click', () => {
    if (state.preview.url) window.open(state.preview.url, '_blank', 'noopener');
  });
  $('previewDownloadBtn').addEventListener('click', async () => {
    const label = state.labels[state.preview.labelId];
    if (!label) return;
    try {
      fallbackDownload(asFile(await getLabelBlob(label), label.filename, labelMime(label)));
    } catch (err) {
      toast(`無法下載：${err.message}`);
    }
  });

  // 條碼掃描
  $('scanBtn').addEventListener('click', async () => {
    if (state.scanning) {
      await stopScanner();
      return;
    }
    $('reader').classList.add('show');
    $('scanBtn').textContent = '⏹ 停止掃描';
    const scanner = new Html5Qrcode('reader');
    state.scanning = scanner;
    try {
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 270, height: 130 }, aspectRatio: 1.5 }, text => {
        const tail = barcodeTail6(text);
        $('barcodeInput').value = tail;
        doSearch(tail);
        stopScanner();
        toast('掃描成功，已使用尾 6 碼搜尋');
      }, () => {});
    } catch (err) {
      toast(`無法開啟相機：${err.message || '請確認權限'}`);
      await stopScanner();
    }
  });

  $('clearDataBtn').addEventListener('click', async () => {
    if (!confirm('確定清除所有「本機」資料？雲端 D1 / R2 資料不會被刪除。')) return;
    if (!confirm('再確認一次：本機商品、標籤與 PDF 快取都會被清除，且無法復原。')) return;
    await db.clearAllLocal();
    state.products = [];
    state.labels = {};
    state.selectedLabelIds.clear();
    matcher.setProducts([]);
    pipeline.setProducts([]);
    pipeline.setLabels({});
    jobsView.reset();
    updateStats();
    renderMatchList();
    hideStatus('excelStatus');
    hideStatus('pdfStatus');
    $('searchResults').innerHTML = '';
    toast('已清除本機資料');
  });
}

async function stopScanner() {
  const scanner = state.scanning;
  state.scanning = null;
  if (scanner) {
    try {
      await scanner.stop();
      scanner.clear();
    } catch { /* ignore */ }
  }
  $('reader').classList.remove('show');
  $('scanBtn').textContent = '📷 開啟相機掃描條碼';
}

/* ------------------------------------------------------------------ 啟動 */

async function boot() {
  bindEvents();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw-v6.js', { updateViaCache: 'none' })
        .catch(err => console.warn('Service Worker 註冊失敗', err));
    });
  }

  try {
    state.products = await db.getProducts();
    state.labels = await db.getLabels();
    // 修正舊資料：商品指向不存在的標籤
    for (const product of state.products) {
      if (product.labelId && !state.labels[product.labelId]) product.labelId = null;
    }
    for (const label of Object.values(state.labels)) {
      if (label.productId == null) continue;
      const product = state.products.find(p => p.id === label.productId);
      if (product && !product.labelId) product.labelId = label.id;
    }
    pipeline.setProducts(state.products);
    pipeline.setLabels(state.labels);
    matcher.setProducts(state.products);
    matcher.setManualLabelIds(manualLabelIdSet());
    updateStats();
    renderMatchList();

    // 回復上次未完成的匯入（若有）
    const savedJobs = await db.getJobs();
    if (savedJobs.length) {
      await pipeline.restore(savedJobs);
      for (const job of pipeline.getJobs()) jobsView.update(job);
      jobsView.summary(pipeline.summary());
    }

    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    cloudReady = loadCloudData();
    await cloudReady;
    updateStats();
    renderMatchList();
  } catch (err) {
    console.error('初始化失敗', err);
    showStatus('cloudStatus', `初始化失敗：${err.message}`, 'error');
  }
}

// 全域函式（供 HTML 內既有的 inline 呼叫與除錯使用）
window.app = {
  state,
  reloadCloud: () => { cloudReady = loadCloudData(); return cloudReady; },
  pipeline,
  matcher,
  previewLabel,
  shareLabel,
  openMatchModal,
  unlinkLabel,
  confirmMatch,
  doSearch,
  syncAllToCloud,
  getLabelBlob,
  // 標籤編輯 / 重複管理（測試與除錯用）
  renderMatchList,
  deleteLabels,
  renameLabel,
  openEditLabelModal,
  closeEditLabelModal,
  duplicateMap,
  extraDuplicateIds,
  labelDupKey,
  openClearCloudModal,
  runClearCloud,
  closeClearCloudModal,
  keepOnlyWdfx,
  deleteAllPdf,
  setDeferred,
  deferAllUnmatched,
  formatSummary,
  formatOf
};

boot();
