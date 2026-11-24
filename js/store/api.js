/*
 * Cloudflare Pages Functions API 客戶端（D1 + R2）
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(message || `請求超過 ${ms}ms 未回應`, 0, null)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createApi({ base = './api/', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const url = method === 'GET' ? `${base}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}` : `${base}${path}`;
    const response = await withTimeout(
      doFetch(url, { ...options, cache: 'no-store', credentials: 'same-origin' }),
      options.timeoutMs || 120000,
      '雲端請求逾時'
    );
    let body = null;
    let rawText = '';
    try { body = await response.json(); } catch {
      // Cloudflare 在 D1 出錯時可能直接回傳純文字（例如 error code: 1101）
      try { rawText = (await response.clone().text()).slice(0, 200).trim(); } catch { /* ignore */ }
    }
    if (!response.ok) {
      let message = (body && body.error) || rawText || `雲端 API ${response.status}`;
      if (/D1|1101|exceeded/i.test(message)) {
        message = `${message}｜雲端資料庫暫時不可用（D1 免費額度每日 UTC 午夜重置，或可升級方案）`;
      }
      throw new ApiError(message, response.status, body);
    }
    return body;
  }

  return {
    request,

    /** 便宜版本檢查：只讀 2 列 meta，不要用它抓商品 */
    async meta() {
      return request('meta', { timeoutMs: 20000 });
    },

    async labelList() {
      return request('labels', { timeoutMs: 30000 });
    },

    async bootstrap(revision) {
      const suffix = revision ? `?rev=${encodeURIComponent(revision)}` : '';
      return request(`bootstrap${suffix}`, { timeoutMs: 60000 });
    },

    async productsBulk(products, { replace = false } = {}) {
      return request('products/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ products, mode: replace ? 'replace' : 'merge' }),
        timeoutMs: 60000
      });
    },

    /** 上傳單一 PDF。id 由內容 hash 產生，因此重試不會產生重複資料。 */
    async uploadLabel(label, file, { timeoutMs = 180000 } = {}) {
      const form = new FormData();
      form.append('file', file, label.filename || 'label.pdf');
      form.append('id', label.id);
      form.append('hash', label.hash || '');
      form.append('size', String(label.size || (file && file.size) || 0));
      form.append('filename', label.filename || 'label.pdf');
      form.append('mime', label.mime || 'application/pdf');
      form.append('ext', label.ext || 'pdf');
      form.append('nameFromFile', label.nameFromFile || label.filename || '');
      form.append('productId', label.productId == null ? '' : String(label.productId));
      form.append('matchedProductName', label.matchedProductName || '');
      form.append('matchSource', label.matchSource || '');
      form.append('matchScore', label.matchScore == null ? '' : String(label.matchScore));
      form.append('matchConfidence', label.matchConfidence || '');
      form.append('matchGap', label.matchGap == null ? '' : String(label.matchGap));
      form.append('matchWhy', label.matchWhy || '');
      form.append('uploadedAt', label.uploadedAt || new Date().toISOString());
      return request('labels', { method: 'POST', body: form, timeoutMs });
    },

    /** 批次更新配對結果（一次最多 200 筆），避免 174 個 PATCH 請求。 */
    async syncLabelMeta(labels) {
      return request('labels/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labels }),
        timeoutMs: 60000
      });
    },

    async patchLabel(id, fields) {
      return request(`labels/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields)
      });
    },

    /** 清除雲端資料（需輸入「清除」確認字串） */
    async clearCloud({ scope, confirm }) {
      return request('cloud/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, confirm }),
        timeoutMs: 180000
      });
    },

    async bulkDeleteLabels(ids) {
      return request('labels/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
        timeoutMs: 60000
      });
    },

    async deleteLabel(id) {
      return request(`labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    labelFileUrl(id) {
      return `${base}labels/${encodeURIComponent(id)}/file`;
    }
  };
}
