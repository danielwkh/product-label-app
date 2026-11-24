/*
 * PDF 匯入流程（與畫面完全解耦，可在瀏覽器或 Node 測試中執行）
 *
 * 每個檔案是一份獨立的 job，狀態機如下：
 *
 *   pending → hashing → dedupe → saving → matching → ready → uploading → done
 *                    ↘ duplicate（已存在，直接跳過）
 *                    ↘ failed（單檔失敗，不影響其他檔案，可重試）
 *
 * 設計重點：
 *  - 本機階段（儲存 + 配對）與雲端階段（上傳）完全分離：
 *    每完成一個檔案的配對就立即排入上傳佇列，本機階段不必等網路。
 *  - 本機階段是「單一 runner」，一次只做一個檔案，最後一次 yield 給主執行緒。
 *  - 上傳階段是「有限並行佇列」（預設 2），含重試與退避。
 *  - 每個檔案都有 try/catch，失敗只標記自己。
 *  - job 狀態寫入 IndexedDB，重新整理後可續傳。
 *  - 同一個 PDF（內容 hash + 檔名）只會被儲存、上傳一次。
 */

import { sniffFile, extFromName, stripExtension } from './filetype.js';

export const STATUS = {
  PENDING: 'pending',
  HASHING: 'hashing',
  SAVING: 'saving',
  MATCHING: 'matching',
  READY: 'ready',
  UPLOADING: 'uploading',
  DONE: 'done',
  DUPLICATE: 'duplicate',
  FAILED: 'failed'
};

export const STATUS_LABEL = {
  pending: '待處理',
  hashing: '計算指紋',
  saving: '本機保存',
  matching: '配對中',
  ready: '已配對',
  uploading: '上傳中',
  done: '完成',
  duplicate: '已存在（略過）',
  failed: '失敗'
};

const TERMINAL = new Set([STATUS.DONE, STATUS.DUPLICATE]);
const RESUMABLE_NEW = new Set([STATUS.PENDING, STATUS.HASHING, STATUS.SAVING, STATUS.MATCHING, STATUS.READY, STATUS.UPLOADING]);

export function makeJob(file, index) {
  const name = file.name || `label-${index}`;
  return {
    id: `J${index}-${name.length}-${file.lastModified || 0}-${file.size || 0}-${hashName(name)}`,
    name,
    size: file.size || 0,
    lastModified: file.lastModified || 0,
    labelId: null,
    hash: null,
    status: STATUS.PENDING,
    storage: 'local',
    matched: false,
    kind: 'pdf',
    mime: 'application/pdf',
    ext: 'pdf',
    uploaded: false,
    attempts: 0,
    uploadAttempts: 0,
    error: null,
    updatedAt: new Date().toISOString()
  };
}

function hashName(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * @param {object} deps
 * @param {object} deps.store    IndexedDB 介面（見 js/store/db.js）
 * @param {object} deps.matcher  { setProducts(products), matchBatch(items) }
 * @param {object} deps.uploader { upload(label, file) }
 * @param {object} [deps.hooks]  { onJob, onSummary, onLog, onMode }
 * @param {object} [deps.config]
 */
export function createImportPipeline(deps) {
  const store = deps.store;
  const matcher = deps.matcher;
  const uploader = deps.uploader;
  const hooks = deps.hooks || {};
  const config = Object.assign({
    concurrency: 2,
    matchBatchSize: 8,
    storageMode: 'auto',
    productsFlushSize: 25,
    dedupe: true
  }, deps.config || {});

  const jobs = [];
  const files = new Map();      // jobId → File
  const results = new Map();    // labelId → match result
  let labels = {};              // labelId → label record（metadata）
  let products = [];
  let manualLabelIds = new Set();
  const dirtyProducts = new Map();
  let pendingMatch = [];
  let mode = config.storageMode === 'auto' ? 'local' : config.storageMode;
  let localRunning = false;
  let paused = false;
  let stopped = false;
  let cursor = 0;
  let uploadQueue = null;
  let flushTimer = null;
  let startedAt = 0;
  let bytesProcessed = 0;

  const onJob = job => hooks.onJob && hooks.onJob(job);
  const onLog = msg => hooks.onLog && hooks.onLog(msg);

  function emitSummary(extra = {}) {
    if (!hooks.onSummary) return;
    const counts = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    hooks.onSummary({
      total: jobs.length,
      counts,
      done: (counts[STATUS.DONE] || 0) + (counts[STATUS.DUPLICATE] || 0),
      failed: counts[STATUS.FAILED] || 0,
      matched: jobs.filter(j => j.matched).length,
      uploaded: jobs.filter(j => j.uploaded).length,
      mode,
      paused,
      running: localRunning,
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      ...extra
    });
  }

  function touch(job) {
    job.updatedAt = new Date().toISOString();
    onJob(job);
    emitSummary();
  }

  function setStatus(job, status, error) {
    job.status = status;
    if (error !== undefined) job.error = error;
    touch(job);
    store.putJob(job).catch(() => { /* job 狀態是輔助資料，寫失敗不影響流程 */ });
  }

  const yieldToMain = () => {
    if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, 0));
  };

  /* ------------------------------------------------------------ 商品與標籤 */

  function setProducts(list) {
    products = Array.isArray(list) ? list : [];
    manualLabelIds = new Set(
      Object.values(labels).filter(l => l && l.matchSource === 'manual').map(l => l.id)
    );
    matcher.setProducts(products);
  }

  function setLabels(map) {
    labels = map || {};
    manualLabelIds = new Set(
      Object.values(labels).filter(l => l && l.matchSource === 'manual').map(l => l.id)
    );
  }

  function productById(id) {
    if (id == null) return null;
    for (const p of products) if (p.id === id) return p;
    return null;
  }

  function markProductDirty(productId, labelId) {
    const product = productById(productId);
    if (!product) return;
    product.labelId = labelId;
    dirtyProducts.set(product.id, product);
  }

  async function flushProducts(force = false) {
    if (!dirtyProducts.size) return;
    if (!force && dirtyProducts.size < config.productsFlushSize) return;
    const list = [...dirtyProducts.values()];
    dirtyProducts.clear();
    try {
      await store.putProducts(list);
    } catch (err) {
      onLog(`商品配對回寫失敗：${err.message}`);
    }
  }

  /* --------------------------------------------------------------- 配對階段 */

  async function flushMatches(options = {}) {
    if (!pendingMatch.length) return;
    const batch = pendingMatch;
    pendingMatch = [];
    const items = [];
    for (const job of batch) {
      if (!labels[job.labelId]) continue;
      items.push({ key: job.id, name: labels[job.labelId].nameFromFile || labels[job.labelId].filename, labelId: job.labelId });
    }
    if (!items.length) return;

    let matched = [];
    try {
      matched = await matcher.matchBatch(items);
    } catch (err) {
      onLog(`配對 worker 失敗，改用主執行緒：${err.message}`);
      matched = items.map(item => ({ key: item.key, result: null }));
    }

    const byKey = new Map(matched.map(m => [m.key, m.result]));
    const labelUpdates = [];
    for (const job of batch) {
      const label = labels[job.labelId];
      if (!label) continue;
      const result = byKey.get(job.id) || null;
      results.set(label.id, result);

      if (result && result.confidence !== 'low') {
        // 同一個商品若被其他非人工標籤佔用，先釋放舊標籤
        const previousId = result.productId;
        const product = productById(previousId);
        if (product && product.labelId && product.labelId !== label.id) {
          const old = labels[product.labelId];
          if (old && old.matchSource !== 'manual') {
            old.matchedProductName = null;
            old.matchSource = null;
            old.matchScore = null;
            old.matchConfidence = null;
            old.matchGap = null;
            old.matchWhy = null;
            old.productId = null;
            old.updatedAt = new Date().toISOString();
            labelUpdates.push(old);
          }
        }
        markProductDirty(previousId, label.id);
        label.matchedProductName = product ? product.name : result.productName;
        label.productId = previousId;
        label.matchSource = 'auto';
        label.matchScore = result.score;
        label.matchConfidence = result.confidence;
        label.matchGap = result.gap;
        label.matchWhy = (result.why || []).join('、');
        job.matched = true;
      } else {
        label.matchedProductName = null;
        label.productId = null;
        label.matchSource = null;
        label.matchScore = null;
        label.matchConfidence = 'low';
        label.matchGap = null;
        label.matchWhy = null;
        job.matched = false;
      }
      label.updatedAt = new Date().toISOString();
      labelUpdates.push(label);
      if (jobs.includes(job)) setStatus(job, STATUS.READY);
      if (!options.skipUpload) enqueueUpload(label, job);
    }

    if (labelUpdates.length) {
      try {
        await store.putLabels(dedupeById(labelUpdates));
      } catch (err) {
        onLog(`配對結果寫入本機失敗：${err.message}`);
      }
    }
    await flushProducts();
  }

  function dedupeById(list) {
    const map = new Map();
    for (const item of list) map.set(item.id, item);
    return [...map.values()];
  }

  /* --------------------------------------------------------------- 上傳階段 */

  function uploaderEnabled() {
    if (!uploader) return false;
    if (typeof uploader.enabled === 'function') {
      try { return Boolean(uploader.enabled()); } catch { return false; }
    }
    return true;
  }

  function enqueueUpload(label, job) {
    if (!uploader || !uploadQueue) return;
    if (!uploaderEnabled()) return;
    if (label.uploaded || job.uploaded) return;
    if (!files.has(job.id) && !label.hasLocalBlob) return;
    if (paused) {
      if (jobs.includes(job)) setStatus(job, STATUS.READY);
      return;
    }
    uploadQueue.add({
      key: job.id,
      run: async () => {
        const file = files.get(job.id);
        if (!file) {
          if (label.uploaded) return;
          throw Object.assign(new Error('檔案不在記憶體中，請重新選擇'), { fatal: true });
        }
        setStatus(job, STATUS.UPLOADING);
        try {
          await uploader.upload(label, file);
          label.uploaded = true;
          label.uploadedAt = label.uploadedAt || new Date().toISOString();
          label.updatedAt = new Date().toISOString();
          job.uploaded = true;
          await store.putLabel(label);
          setStatus(job, STATUS.DONE);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          job.error = `上傳失敗：${message}`;
          setStatus(job, STATUS.FAILED);
          throw err;
        }
      }
    }, { labelId: label.id });
  }

  /* --------------------------------------------------------- 本機階段主流程 */

  async function processOne(job) {
    const file = files.get(job.id);
    if (!file) {
      job.error = '檔案已不在記憶體中，請重新選擇此 PDF';
      setStatus(job, STATUS.FAILED);
      return;
    }

    // 1. 指紋
    setStatus(job, STATUS.HASHING);
    const hash = await contentHashOf(file);
    job.hash = hash;
    const labelId = makeLabelIdOf(hash, file.name || job.name);
    job.labelId = labelId;
    bytesProcessed += file.size || 0;

    // 2. 去重（同內容 + 同檔名 → 同一個 id）
    const existing = labels[labelId];
    if (existing && config.dedupe) {
      const blobExists = existing.hasLocalBlob && await store.hasBlob(hash);
      const remoteExists = Boolean(existing.uploaded || existing.remote);
      if (blobExists || remoteExists) {
        job.matched = Boolean(existing.matchedProductName);
        job.uploaded = Boolean(existing.uploaded);
        job.storage = existing.hasLocalBlob ? 'local' : 'cloud';
        setStatus(job, STATUS.DUPLICATE);
        return;
      }
    }

    // 3. 本機儲存（blob 只寫一次）
    setStatus(job, STATUS.SAVING);
    const kindInfo = job.kind ? { kind: job.kind, mime: job.mime, ext: job.ext } : await sniffFile(file);
    job.kind = kindInfo.kind;
    job.mime = kindInfo.mime;
    job.ext = kindInfo.ext;

    const label = Object.assign({
      id: labelId,
      filename: file.name || job.name,
      nameFromFile: stripExtension(file.name || job.name),
      kind: kindInfo.kind,
      mime: kindInfo.mime,
      ext: kindInfo.ext,
      hash,
      size: file.size || 0,
      uploadedAt: (existing && existing.uploadedAt) || new Date().toISOString(),
      createdAt: (existing && existing.createdAt) || new Date().toISOString()
    }, existing || {});

    label.filename = file.name || job.name;
    label.nameFromFile = label.nameFromFile || stripExtension(file.name || job.name);
    label.kind = label.kind || kindInfo.kind;
    label.mime = label.mime || kindInfo.mime;
    label.ext = label.ext || kindInfo.ext;
    label.hash = hash;
    label.size = file.size || 0;

    const alreadyStored = existing && existing.hasLocalBlob && await store.hasBlob(hash);
    if (!alreadyStored && mode === 'local') {
      try {
        await store.putBlob(hash, file, {
          name: file.name || job.name,
          mime: kindInfo.mime,
          kind: kindInfo.kind,
          ext: kindInfo.ext
        });
        label.hasLocalBlob = true;
      } catch (err) {
        if (/quota|storage|space/i.test(String(err && (err.name + err.message)))) {
          onLog('本機儲存空間不足，後續 PDF 改為「先上傳到 R2，只保留 metadata」模式');
          mode = 'cloud';
          if (hooks.onMode) hooks.onMode(mode);
          label.hasLocalBlob = false;
        } else {
          throw err;
        }
      }
    }
    // 雲端模式：本機只存 metadata（不上傳 blob）
    label.storage = label.hasLocalBlob ? 'local' : 'cloud';
    job.storage = label.storage;

    labels[label.id] = label;
    await store.putLabel(label);

    // 4. 配對（丟給 worker，允許批次累積）
    setStatus(job, STATUS.MATCHING);
    pendingMatch.push(job);
    if (pendingMatch.length >= config.matchBatchSize) await flushMatches();
  }

  async function localLoop() {
    if (localRunning) return;
    localRunning = true;
    if (!startedAt) startedAt = Date.now();
    emitSummary();
    try {
      while (cursor < jobs.length && !stopped) {
        if (paused) break;
        const job = jobs[cursor];
        const skip = TERMINAL.has(job.status) || job.status === STATUS.FAILED;
        if (skip) {
          cursor++;
          continue;
        }
        try {
          await processOne(job);
          job.error = null;
        } catch (err) {
          job.attempts++;
          job.error = err && err.message ? err.message : String(err);
          setStatus(job, STATUS.FAILED);
          onLog(`${job.name}：${job.error}`);
        }
        cursor++;
        await yieldToMain();
      }
      if (!paused) {
        await flushMatches();
        await flushProducts(true);
        pumpReadyUploads();
      }
    } finally {
      localRunning = false;
      emitSummary();
      if (hooks.onLocalIdle) hooks.onLocalIdle();
    }
  }

  /* ------------------------------------------------------------------- 對外 */

  function pumpReadyUploads() {
    for (const job of jobs) {
      if (job.status !== STATUS.READY) continue;
      const label = job.labelId && labels[job.labelId];
      if (label && !label.uploaded) enqueueUpload(label, job);
    }
  }

  const api = {
    STATUS,

    setProducts(list) {
      setProducts(list);
    },

    setLabels(map) {
      setLabels(map);
    },

    attach(storeImpl) {
      if (storeImpl) api.store = storeImpl;
    },

    /** 初始化上傳佇列（由 app.js 傳入 createTaskQueue） */
    initUploadQueue(factory) {
      uploadQueue = factory({
        concurrency: config.concurrency,
        onUpdate: () => emitSummary(),
        execute: task => task.run()
      });
      return uploadQueue;
    },

    async intake(fileList) {
      // 不再用副檔名過濾：改看檔頭（PDF 改名成 .wdfx 也能正確辨識）
      const list = Array.from(fileList || []).filter(f => f && (f.size || 0) > 0);
      if (!list.length) return { added: 0, total: jobs.length };
      const base = jobs.length;
      const kinds = new Map();
      for (const file of list) kinds.set(file, await sniffFile(file));
      list.forEach((file, i) => {
        const job = makeJob(file, base + i);
        const kindInfo = kinds.get(file);
        if (kindInfo) {
          job.kind = kindInfo.kind;
          job.mime = kindInfo.mime;
          job.ext = kindInfo.ext;
        }
        // 同一個檔案被重複選取兩次：合併成一個 job
        const duplicate = jobs.find(j => j.id === job.id);
        if (duplicate) {
          files.set(duplicate.id, file);
          return;
        }
        jobs.push(job);
        files.set(job.id, file);
        onJob(job);
      });
      store.putJobs(jobs.filter(j => j.status === STATUS.PENDING)).catch(() => {});
      emitSummary();
      return { added: list.length, total: jobs.length };
    },

    async decideStorageMode() {
      if (config.storageMode !== 'auto') {
        mode = config.storageMode;
        if (hooks.onMode) hooks.onMode(mode);
        return mode;
      }
      const estimate = store.storageEstimate ? await store.storageEstimate() : null;
      const needed = jobs.reduce((sum, job) => sum + (job.size || 0), 0);
      if (estimate && estimate.quota) {
        const free = estimate.quota - (estimate.usage || 0);
        mode = free > needed * 1.35 ? 'local' : 'cloud';
      } else {
        mode = 'local';
      }
      if (hooks.onMode) hooks.onMode(mode);
      emitSummary();
      return mode;
    },

    start() {
      if (stopped) return;
      paused = false;
      if (uploadQueue && uploadQueue.resume) uploadQueue.resume();
      return localLoop();
    },

    pause() {
      paused = true;
      if (uploadQueue && uploadQueue.pause) uploadQueue.pause();
      emitSummary();
    },

    resume() {
      if (stopped) return;
      paused = false;
      if (uploadQueue && uploadQueue.resume) uploadQueue.resume();
      emitSummary();
      pumpReadyUploads();
      return localLoop();
    },

    stop() {
      stopped = true;
      if (uploadQueue && uploadQueue.stop) uploadQueue.stop();
    },

    /** 重試失敗的檔案（只重試本機階段失敗、且檔案仍在記憶體中的） */
    async retryFailed() {
      let count = 0;
      for (const job of jobs) {
        if (job.status !== STATUS.FAILED) continue;
        if (!files.has(job.id)) continue;
        job.status = STATUS.PENDING;
        job.error = null;
        count++;
        onJob(job);
      }
      // 重設 cursor，讓失敗項目重新跑一次
      const firstRetry = jobs.findIndex(j => j.status === STATUS.PENDING);
      if (firstRetry >= 0) cursor = Math.min(cursor, firstRetry);
      emitSummary();
      if (count) await localLoop();
      return count;
    },

    /** 重新上傳「已在本機、但雲端還沒有」的標籤 */
    async retryUploads() {
      let count = 0;
      for (const job of jobs) {
        const label = job.labelId && labels[job.labelId];
        if (!label) continue;
        if (label.uploaded) continue;
        if (!files.has(job.id) && !label.hasLocalBlob) continue;
        job.status = STATUS.READY;
        job.error = null;
        enqueueUpload(label, job);
        count++;
      }
      emitSummary();
      return count;
    },

    /** 重新配對全部標籤（Excel 更新後使用） */
    async rematchAll({ includeManual = false, onProgress } = {}) {
      const targets = Object.values(labels).filter(l => includeManual || l.matchSource !== 'manual');
      const chunk = config.matchBatchSize;
      let processed = 0;
      // 先把先前累積的配對做完，避免覆蓋掉同時進行的匯入工作
      await flushMatches();
      for (let i = 0; i < targets.length; i += chunk) {
        const slice = targets.slice(i, i + chunk);
        for (const label of slice) {
          // 用已經存在的 label 直接產生一個暫時 job 來跑 flushMatches 的共用邏輯
          const pseudo = {
            id: `rematch-${label.id}`,
            labelId: label.id,
            matched: false,
            uploaded: label.uploaded,
            status: label.uploaded ? STATUS.DONE : STATUS.READY,
            hash: label.hash,
            name: label.filename
          };
          pendingMatch.push(pseudo);
        }
        await flushMatches({ skipUpload: true });
        processed += slice.length;
        if (onProgress) onProgress(processed, targets.length);
        await yieldToMain();
      }
      await flushProducts(true);
      return processed;
    },

    async waitUploads() {
      if (uploadQueue) await uploadQueue.onIdle();
    },

    /** 重新整理後的回復：不重跑已完成的檔案 */
    async restore(savedJobs) {
      const list = Array.isArray(savedJobs) ? savedJobs : [];
      for (const saved of list) {
        if (!saved || !saved.id) continue;
        if (jobs.find(j => j.id === saved.id)) continue;
        const label = saved.labelId ? labels[saved.labelId] : null;
        const job = { ...saved };
        if (job.status === STATUS.UPLOADING || job.status === STATUS.READY || job.status === STATUS.MATCHING || job.status === STATUS.SAVING || job.status === STATUS.HASHING) {
          if (label && (label.hasLocalBlob || label.uploaded)) {
            job.status = label.uploaded ? STATUS.DONE : (label.matchedProductName ? STATUS.READY : STATUS.PENDING);
            job.labelId = label.id;
            job.hash = label.hash;
            job.matched = Boolean(label.matchedProductName);
            job.uploaded = Boolean(label.uploaded);
            if (!label.uploaded && label.hasLocalBlob) {
              // 有本機 blob 但沒有 file 物件 → 之後可用 blob 重新上傳
              job.status = STATUS.READY;
            }
          } else {
            job.status = STATUS.FAILED;
            job.error = '頁面重新載入後檔案已釋放，請重新選擇此 PDF';
          }
        }
        jobs.push(job);
        onJob(job);
      }
      emitSummary();
      return jobs.length;
    },

    getJobs() {
      return jobs;
    },

    getLabels() {
      return labels;
    },

    getResults() {
      return results;
    },

    getMode() {
      return mode;
    },

    summary() {
      const counts = {};
      for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
      return { total: jobs.length, counts, mode, paused, running: localRunning };
    },

    /** 清除已完成 / 重複的 job（不動任何 PDF 或商品資料） */
    async clearFinishedJobs() {
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (TERMINAL.has(jobs[i].status)) {
          await store.deleteJob(jobs[i].id).catch(() => {});
          files.delete(jobs[i].id);
          jobs.splice(i, 1);
        }
      }
      // 陣列被壓縮過，重新從頭掃描（已完成的 job 會被 skip）
      cursor = 0;
      emitSummary();
    }
  };

  // 依賴注入（避免 pipeline.js 直接 import 瀏覽器模組，方便 Node 測試）
  const contentHashOf = deps.contentHash || (async () => { throw new Error('缺少 contentHash 依賴'); });
  const makeLabelIdOf = deps.makeLabelId || ((hash, name) => `L${hash.slice(0, 20)}-${hashName(name)}`);

  api.store = store;
  return api;
}
