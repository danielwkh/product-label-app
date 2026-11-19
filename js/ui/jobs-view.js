/*
 * 匯入進度 UI
 *
 * 只更新「有變動的那一列」，不整份 innerHTML 重畫。
 * 舊版每處理一個檔案就呼叫 showStatus + 之後 renderMatchList()，
 * 174 個標籤的 innerHTML 重建會讓主執行緒反覆卡頓，也讓進度條看起來凍住。
 */

const STATUS_CLASS = {
  pending: 'st-pending',
  hashing: 'st-working',
  saving: 'st-working',
  matching: 'st-working',
  ready: 'st-ready',
  uploading: 'st-uploading',
  done: 'st-done',
  duplicate: 'st-dup',
  failed: 'st-failed'
};

const STATUS_TEXT = {
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

const MAX_ROWS = 300;

export function createJobsView(root, handlers = {}) {
  const listEl = root.querySelector('#jobList');
  const countsEl = root.querySelector('#jobCounts');
  const barEl = root.querySelector('#jobBar');
  const pauseBtn = root.querySelector('#jobPauseBtn');
  const resumeBtn = root.querySelector('#jobResumeBtn');
  const retryBtn = root.querySelector('#jobRetryBtn');
  const clearBtn = root.querySelector('#jobClearBtn');
  const modeEl = root.querySelector('#jobMode');

  const rows = new Map();
  let overflow = 0;

  if (pauseBtn) pauseBtn.addEventListener('click', () => handlers.onPause && handlers.onPause());
  if (resumeBtn) resumeBtn.addEventListener('click', () => handlers.onResume && handlers.onResume());
  if (retryBtn) retryBtn.addEventListener('click', () => handlers.onRetry && handlers.onRetry());
  if (clearBtn) clearBtn.addEventListener('click', () => handlers.onClear && handlers.onClear());

  function ensureRow(job) {
    let row = rows.get(job.id);
    if (row) return row;
    if (rows.size >= MAX_ROWS) {
      overflow++;
      return { overflow: true };
    }
    const el = document.createElement('div');
    el.className = 'job-row';
    el.innerHTML = `
      <div class="job-main">
        <div class="job-name"></div>
        <div class="job-meta"><span class="job-size"></span><span class="job-error"></span></div>
      </div>
      <div class="job-status"></div>`;
    el.querySelector('.job-name').textContent = job.name || '';
    el.querySelector('.job-size').textContent = formatBytes(job.size);
    if (job.error) el.querySelector('.job-error').textContent = job.error;
    listEl.appendChild(el);
    row = {
      el,
      status: el.querySelector('.job-status'),
      error: el.querySelector('.job-error')
    };
    rows.set(job.id, row);
    return row;
  }

  function update(job) {
    const row = ensureRow(job);
    if (row.overflow) return;
    const cls = STATUS_CLASS[job.status] || 'st-pending';
    row.status.className = `job-status ${cls}`;
    row.status.textContent = STATUS_TEXT[job.status] || job.status;
    if (job.error) {
      row.error.textContent = job.error;
      row.error.classList.add('show');
    } else {
      row.error.textContent = '';
      row.error.classList.remove('show');
    }
    row.el.dataset.status = job.status;
  }

  function summary(state) {
    if (!state) return;
    const c = state.counts || {};
    const parts = [
      `共 ${state.total} 個`,
      `完成 ${(c.done || 0) + (c.duplicate || 0)}`,
      `進行中 ${(c.hashing || 0) + (c.saving || 0) + (c.matching || 0) + (c.uploading || 0)}`,
      `待處理 ${c.pending || 0}`
    ];
    if (c.failed) parts.push(`失敗 ${c.failed}`);
    if (c.duplicate) parts.push(`已存在 ${c.duplicate}`);
    if (countsEl) countsEl.textContent = parts.join(' · ');
    const total = state.total || 1;
    const percent = Math.round(((state.total - (c.pending || 0) - (c.hashing || 0) - (c.saving || 0) - (c.matching || 0)) / total) * 100);
    if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (modeEl) {
      modeEl.textContent = state.mode === 'cloud'
        ? '儲存模式：雲端優先（本機只存 metadata）'
        : '儲存模式：本機 + 雲端（IndexedDB 快取 PDF）';
    }
    if (pauseBtn) pauseBtn.disabled = Boolean(state.paused) || !state.running;
    if (resumeBtn) resumeBtn.disabled = !state.paused;
    if (retryBtn) retryBtn.disabled = !(c.failed > 0);
    if (clearBtn) clearBtn.disabled = !((c.done || 0) + (c.duplicate || 0) > 0);
  }

  return {
    update,
    summary,
    reset() {
      rows.clear();
      overflow = 0;
      if (listEl) listEl.innerHTML = '';
    },
    get overflowCount() {
      return overflow;
    }
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
