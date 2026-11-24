/*
 * IndexedDB 存取層（v3）
 *
 * 與舊版的三個關鍵差別：
 *
 * 1. PDF Blob 移到獨立 object store `blobs`（以內容 hash 為 key）。
 *    舊版把 blob 直接放在 label 記錄裡，於是啟動時 getAll('labels') 會把
 *    全部 PDF 一次反序列化進記憶體 —— 174 個 PDF 之後，iPhone Safari
 *    往往在啟動階段就被系統終止（看起來像「卡住」或自動重新載入）。
 *
 * 2. 每個 transaction 都有 timeout + onabort 處理。
 *    舊版只寫 tx.oncomplete / tx.onerror；iOS 在背景、螢幕鎖定或儲存壓力下
 *    會讓 transaction 停在 pending，回呼永遠不觸發，於是 await 永久卡住
 *    （就是「停在 10 / 174」的直接原因）。現在超時會 abort 並拋出可重試錯誤。
 *
 * 3. 寫入一律「每檔一個小 transaction」，可重試、可續傳，不會因為單一檔案
 *    失敗而讓整個批次消失。
 */

export const DB_NAME = 'ProductLabelDB';
export const DB_VERSION = 3;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = event => {
      const db = req.result;
      const tx = req.transaction;

      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('labels')) {
        db.createObjectStore('labels', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      // v2 → v3 遷移：把 label 記錄內的 blob 搬到 blobs store。
      // 用 cursor 逐筆處理，避免一次 getAll 把全部 PDF 讀進記憶體。
      if (event.oldVersion > 0 && event.oldVersion < 3 && db.objectStoreNames.contains('labels')) {
        const labelsStore = tx.objectStore('labels');
        const blobsStore = db.objectStoreNames.contains('blobs') ? tx.objectStore('blobs') : null;
        if (blobsStore) {
          labelsStore.openCursor().onsuccess = ev => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const value = cursor.value;
            if (value && value.blob) {
              const hash = value.hash || `legacy-${value.id}`;
              try {
                blobsStore.put({
                  hash,
                  blob: value.blob,
                  size: value.blob.size || value.size || 0,
                  type: value.blob.type || 'application/pdf'
                });
              } catch (err) {
                console.warn('blob migrate failed', err);
              }
              const copy = Object.assign({}, value, { hash, hasLocalBlob: true });
              delete copy.blob;
              cursor.update(copy);
            }
            cursor.continue();
          };
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 無法開啟'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他分頁鎖住，請關閉其他分頁後重試'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

export class TimeoutError extends Error {
  constructor(message) {
    super(message || 'IndexedDB transaction timeout');
    this.name = 'TimeoutError';
  }
}

/**
 * 執行一個 transaction。
 * @param {string[]|string} stores
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: IDBTransaction) => any} work 必須「同步」把 request 排進 transaction
 * @param {{timeout?: number, durability?: string}} [options]
 */
export function withTx(stores, mode, work, options = {}) {
  const timeout = options.timeout || 15000;
  return openDB().then(db => new Promise((resolve, reject) => {
    let tx;
    try {
      const params = options.durability ? { durability: options.durability } : undefined;
      tx = params ? db.transaction(stores, mode, params) : db.transaction(stores, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let result;
    let timer = null;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    timer = setTimeout(() => {
      try { tx.abort(); } catch { /* ignore */ }
      done(reject, new TimeoutError(`IndexedDB ${mode} transaction 超過 ${timeout}ms 未完成`));
    }, timeout);

    tx.oncomplete = () => done(resolve, result);
    tx.onerror = () => done(reject, tx.error || new Error('IndexedDB error'));
    tx.onabort = () => done(reject, tx.error || new Error('IndexedDB aborted'));

    try {
      const maybe = work(tx);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(v => { if (v !== undefined) result = v; }).catch(err => {
          try { tx.abort(); } catch { /* ignore */ }
          done(reject, err);
        });
      } else {
        result = maybe;
      }
    } catch (err) {
      try { tx.abort(); } catch { /* ignore */ }
      done(reject, err);
    }
  }));
}

export function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

const RETRYABLE = new Set(['TimeoutError', 'AbortError', 'UnknownError', 'InvalidStateError']);

export async function withRetry(label, fn, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = RETRYABLE.has(err && err.name) || /quota/i.test(String(err && err.message || ''));
      if (!retryable || attempt === attempts) throw err;
      console.warn(`[db] ${label} 第 ${attempt} 次失敗，重試中：`, err && err.message);
      await new Promise(r => setTimeout(r, 120 * attempt * attempt));
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ products */

export async function getProducts() {
  return withTx('products', 'readonly', tx => requestAsPromise(tx.objectStore('products').getAll()), { timeout: 60000 });
}

/** 匯入 Excel 時整份覆寫（商品數量遠少於 PDF，且是使用者明確操作）。 */
export async function replaceProducts(list) {
  return withTx('products', 'readwrite', tx => {
    const store = tx.objectStore('products');
    store.clear();
    for (const p of list) store.put(p);
  }, { timeout: 60000 });
}

export async function clearProducts() {
  return withTx('products', 'readwrite', tx => {
    tx.objectStore('products').clear();
  }, { timeout: 30000 });
}

export async function countProducts() {
  return withTx('products', 'readonly', tx => requestAsPromise(tx.objectStore('products').count()));
}

/**
 * 大量商品寫入：清空後「分塊、逐塊 transaction、塊與塊之間讓出主執行緒」。
 * 舊做法（單一 transaction 寫 2 萬多筆）在 iPhone 上有機會超過 60 秒逾時，
 * 一旦逾時整份快取就沒寫進去，還會被上層誤判成「雲端不可用」。
 */
export async function saveProductsChunked(list, options = {}) {
  const chunkSize = options.chunkSize || 800;
  const onProgress = options.onProgress || null;
  const yieldFn = options.yieldFn || null;
  await clearProducts();
  let written = 0;
  let failedChunks = 0;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    try {
      await withTx('products', 'readwrite', tx => {
        const store = tx.objectStore('products');
        for (const product of chunk) store.put(product);
      }, { timeout: 15000 });
      written += chunk.length;
    } catch (err) {
      failedChunks++;
      console.warn('[db] 商品分塊寫入失敗', i, err && err.message);
      if (failedChunks > 3) throw err;
    }
    if (onProgress) onProgress(written, list.length);
    if (yieldFn) await yieldFn();
  }
  return { written, failedChunks };
}

/** 只更新部分商品（配對結果），不再整表重寫。 */
export async function putProducts(list, chunkSize = 200) {
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    await withTx('products', 'readwrite', tx => {
      const store = tx.objectStore('products');
      for (const p of chunk) store.put(p);
    });
  }
}

/* -------------------------------------------------------------------- labels */

export async function getLabels() {
  const rows = await withTx('labels', 'readonly', tx => requestAsPromise(tx.objectStore('labels').getAll()), { timeout: 60000 });
  const map = {};
  for (const row of rows || []) map[row.id] = row;
  return map;
}

export async function getLabel(id) {
  if (!id) return null;
  return withTx('labels', 'readonly', tx => requestAsPromise(tx.objectStore('labels').get(id)));
}

export async function putLabel(label) {
  return withTx('labels', 'readwrite', tx => {
    tx.objectStore('labels').put(label);
  });
}

export async function putLabels(list, chunkSize = 20) {
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    await withTx('labels', 'readwrite', tx => {
      const store = tx.objectStore('labels');
      for (const label of chunk) store.put(label);
    });
  }
}

export async function clearLabels() {
  return withTx('labels', 'readwrite', tx => {
    tx.objectStore('labels').clear();
  });
}

export async function clearBlobs() {
  return withTx('blobs', 'readwrite', tx => {
    tx.objectStore('blobs').clear();
  }, { timeout: 60000 });
}

export async function deleteLabelRecord(id) {
  return withTx('labels', 'readwrite', tx => {
    tx.objectStore('labels').delete(id);
  });
}

/* --------------------------------------------------------------------- blobs */

export async function putBlob(hash, blob, extra = {}) {
  return withTx('blobs', 'readwrite', tx => {
    tx.objectStore('blobs').put({
      hash,
      blob,
      size: blob.size || 0,
      type: blob.type || 'application/pdf',
      savedAt: new Date().toISOString(),
      ...extra
    });
  }, { timeout: 30000, durability: 'relaxed' });
}

export async function getBlobRecord(hash) {
  if (!hash) return null;
  return withTx('blobs', 'readonly', tx => requestAsPromise(tx.objectStore('blobs').get(hash)));
}

export async function hasBlob(hash) {
  if (!hash) return false;
  const record = await getBlobRecord(hash);
  return Boolean(record && record.blob);
}

export async function deleteBlob(hash) {
  return withTx('blobs', 'readwrite', tx => {
    tx.objectStore('blobs').delete(hash);
  });
}

export async function blobBytes() {
  const rows = await withTx('blobs', 'readonly', tx => requestAsPromise(tx.objectStore('blobs').getAll()), { timeout: 60000 });
  let total = 0;
  for (const row of rows || []) total += row.size || 0;
  return { count: (rows || []).length, bytes: total };
}

/* ---------------------------------------------------------------------- jobs */

export async function getJobs() {
  const rows = await withTx('jobs', 'readonly', tx => requestAsPromise(tx.objectStore('jobs').getAll()));
  return rows || [];
}

export async function putJob(job) {
  return withTx('jobs', 'readwrite', tx => {
    tx.objectStore('jobs').put(job);
  }, { durability: 'relaxed' });
}

export async function putJobs(list) {
  if (!list.length) return;
  return withTx('jobs', 'readwrite', tx => {
    const store = tx.objectStore('jobs');
    for (const job of list) store.put(job);
  }, { durability: 'relaxed' });
}

export async function deleteJob(id) {
  return withTx('jobs', 'readwrite', tx => {
    tx.objectStore('jobs').delete(id);
  }, { durability: 'relaxed' });
}

export async function clearJobs() {
  return withTx('jobs', 'readwrite', tx => {
    tx.objectStore('jobs').clear();
  });
}

/* ---------------------------------------------------------------------- meta */

export async function getMeta(key, fallback = null) {
  try {
    const row = await withTx('meta', 'readonly', tx => requestAsPromise(tx.objectStore('meta').get(key)));
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export async function setMeta(key, value) {
  return withTx('meta', 'readwrite', tx => {
    tx.objectStore('meta').put({ key, value });
  });
}

/* ------------------------------------------------------------------- storage */

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

export async function requestPersistent() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 只在使用者明確確認時呼叫。 */
export async function clearAllLocal() {
  return withTx(['products', 'labels', 'blobs', 'jobs', 'meta'], 'readwrite', tx => {
    for (const name of ['products', 'labels', 'blobs', 'jobs', 'meta']) tx.objectStore(name).clear();
  }, { timeout: 60000 });
}

/* ------------------------------------------------------------- 測試輔助 */

export async function closeDatabase() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  dbPromise = null;
}

export async function deleteDatabase() {
  await closeDatabase();
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
