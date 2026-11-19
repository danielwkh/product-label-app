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
  cloudSyncing: false,
  currentMatchLabelId: null,
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

async function handlePdfSelection(fileList) {
  const files = Array.from(fileList || []).filter(f => /\.pdf$/i.test(f.name || ''));
  if (!files.length) {
    toast('沒有可處理的 PDF');
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
  const { added } = pipeline.intake(files);
  const batchJobs = pipeline.getJobs().filter(j => j.status === STATUS.PENDING);
  void before;
  showStatus('pdfStatus', `已選取 ${files.length} 個 PDF${added < files.length ? `（${files.length - added} 個重複略過）` : ''}，開始本機處理…`);
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
      `本批 ${current.length} 個 PDF：已完成 ${finished} 個${dup ? `（${dup} 個之前已存在而略過）` : ''}、自動配對 ${matchedCount} 個${failed ? `、${failed} 個失敗（可按「重試失敗」）` : ''}。`
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

async function cloudRequestSafe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[cloud] ${label} 失敗`, err);
    throw err;
  }
}

async function loadCloudData() {
  try {
    const data = await api.bootstrap();
    if (!data || !data.cloud) return false;
    state.cloudEnabled = true;

    const remoteProducts = data.products || [];
    const remoteLabels = data.labels || [];
    const hasRemote = remoteProducts.length > 0 || remoteLabels.length > 0;

    if (remoteProducts.length) {
      // 雲端商品為共用來源；保留本機的 labelId 連結
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
      await db.replaceProducts(state.products);
    }

    if (remoteLabels.length) {
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
          hasLocalBlob: Boolean(local && local.hasLocalBlob),
          uploaded: true,
          remote: true
        };
      }
      state.labels = merged;
      // 本機有、雲端未有的標籤（離線建立但未上傳）保留，並標記待上傳
      for (const label of Object.values(state.labels)) {
        if (!label.uploaded) label.remote = false;
      }
      await db.putLabels(Object.values(state.labels), 40);
    }

    pipeline.setProducts(state.products);
    pipeline.setLabels(state.labels);
    matcher.setProducts(state.products);
    matcher.setManualLabelIds(manualLabelIdSet());

    showStatus(
      'cloudStatus',
      hasRemote
        ? `已連線雲端：${state.products.length} 個商品、${Object.keys(state.labels).length} 個標籤`
        : '已連線雲端；雲端目前沒有資料，可同步本機資料'
    );
    return true;
  } catch (err) {
    state.cloudEnabled = false;
    showStatus('cloudStatus', `目前使用本機資料（${err.message}）`, 'error');
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
  if (!state.cloudEnabled) {
    showStatus('cloudStatus', '雲端 API 尚未啟用，請先完成 Cloudflare Pages、D1 及 R2 設定', 'error');
    return;
  }
  if (state.cloudSyncing) return;
  state.cloudSyncing = true;
  showStatus('cloudStatus', '正在同步商品資料…');
  try {
    const list = state.products.map(p => ({
      id: p.id, name: p.name, barcode: p.barcode || '', barcode2: p.barcode2 || '', labelId: p.labelId || null
    }));
    for (let i = 0; i < list.length; i += 200) {
      // 注意：一律使用 merge，不會刪除雲端既有商品
      await api.productsBulk(list.slice(i, i + 200), { replace: false });
    }
    showStatus('cloudStatus', '正在計算本機 PDF 指紋…');
    // 把本機擁有 blob、雲端尚未上傳的標籤排入佇列
    const pending = Object.values(state.labels).filter(l => l.hasLocalBlob && !l.uploaded);
    let queued = 0;
    for (const label of pending) {
      const job = pipeline.getJobs().find(j => j.labelId === label.id);
      if (job) {
        await pipeline.retryUploads();
        queued++;
      } else {
        // 從舊版本匯入、沒有 job 的標籤：補一個虛擬 job
        const record = await db.getBlobRecord(label.hash);
        if (!record || !record.blob) continue;
        try {
          await api.uploadLabel(label, record.blob);
          label.uploaded = true;
          label.remote = true;
          await db.putLabel(label);
          queued++;
        } catch (err) {
          console.warn('上傳舊標籤失敗', label.id, err);
        }
      }
    }
    await pipeline.waitUploads();
    await syncMatchMetadata();
    await refreshStateFromPipeline();
    showStatus('cloudStatus', `同步完成：${list.length} 個商品、${queued} 個本機 PDF 已排入/完成上傳`);
    toast('雲端同步完成');
  } catch (err) {
    showStatus('cloudStatus', `同步失敗：${err.message}`, 'error');
  } finally {
    state.cloudSyncing = false;
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

function renderMatchList() {
  const el = $('matchList');
  if (!el) return;
  const all = Object.values(state.labels).map(label => ({ ...label }));
  const filtered = all
    .filter(l => state.matchFilter === 'all' || (state.matchFilter === 'matched'
      ? l.matchedProductName
      : state.matchFilter === 'review'
        ? l.matchConfidence === 'review'
        : !l.matchedProductName))
    .filter(l => {
      if (!state.matchQuery) return true;
      const q = normalize(state.matchQuery);
      return normalize(`${l.nameFromFile || ''} ${l.matchedProductName || ''}`).includes(q);
    });

  filtered.sort((a, b) => state.matchSort === 'name'
    ? normalize(a.nameFromFile).localeCompare(normalize(b.nameFromFile), 'zh-Hant')
    : state.matchSort === 'newest'
      ? String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
      : Number(!a.matchedProductName) - Number(!b.matchedProductName));

  const visibleIds = new Set(filtered.map(l => l.id));
  for (const id of [...state.selectedLabelIds]) if (!visibleIds.has(id)) state.selectedLabelIds.delete(id);

  $('matchSummary').textContent = `顯示 ${filtered.length} / ${all.length} 個標籤 · 已配對 ${all.filter(x => x.matchedProductName).length} · 待確認 ${all.filter(x => x.matchConfidence === 'review').length} · 未配對 ${all.filter(x => !x.matchedProductName).length}`;

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
        ${l.hasLocalBlob ? '<span class="tag-offline">本機可離線</span>' : (l.uploaded ? '<span class="tag-offline">雲端</span>' : '')}
        ${l.matchScore && !manual ? `<span>信心 ${l.matchScore}${l.matchGap != null ? ` · 差距 ${l.matchGap}` : ''}</span>` : ''}
      </div>
      ${l.matchWhy && !manual ? `<div class="score-note">判斷依據：${escapeHtml(l.matchWhy)}</div>` : ''}
      <div class="label-actions">
        ${linked
          ? `<button class="btn btn-outline btn-sm" data-action="unlink" data-id="${escapeHtml(l.id)}">解除配對</button>
             <button class="btn btn-primary btn-sm" data-action="match" data-id="${escapeHtml(l.id)}">重新配對</button>`
          : `<button class="btn btn-primary btn-sm" data-action="match" data-id="${escapeHtml(l.id)}">手動配對</button>`}
        <button class="btn btn-outline btn-sm" data-action="preview" data-id="${escapeHtml(l.id)}">預覽</button>
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

function asFile(blob, name) {
  return new File([blob], name || 'label.pdf', { type: 'application/pdf' });
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
    const file = asFile(blob, label.filename || 'label.pdf');
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
      fallbackDownload(asFile(await getLabelBlob(label), label.filename));
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

    await loadCloudData();
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
  pipeline,
  matcher,
  previewLabel,
  shareLabel,
  openMatchModal,
  unlinkLabel,
  confirmMatch,
  doSearch,
  syncAllToCloud,
  getLabelBlob
};

boot();
