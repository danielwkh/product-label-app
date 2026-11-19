/*
 * 有限並行佇列（取代 Promise.all 一次射出 174 個請求）
 *
 * 特性：
 *  - concurrency 上限（預設 2，手機網路建議 2~3）
 *  - 每個任務可重試，指數退避；單一任務失敗不會影響其他任務
 *  - pause() / resume()，暫停時已開始的任務會完成，但不會再開新的
 *  - onIdle() 可 await 整批結束（含重試）
 */

export function createTaskQueue(options = {}) {
  const execute = options.execute;
  if (typeof execute !== 'function') throw new Error('createTaskQueue 需要 execute 函式');

  let concurrency = Math.max(1, options.concurrency || 2);
  const defaultRetries = options.retries == null ? 2 : options.retries;
  const backoff = options.backoff || (attempt => Math.min(20000, 600 * Math.pow(2, attempt)));
  const onUpdate = options.onUpdate || (() => {});

  const pending = [];
  const active = new Map();
  let paused = false;
  let stopped = false;
  let completed = 0;
  let failed = 0;
  let idleWaiters = [];

  const stats = () => ({
    queued: pending.length,
    active: active.size,
    completed,
    failed,
    paused,
    total: completed + failed + pending.length + active.size
  });

  function notify() {
    onUpdate(stats());
    if (pending.length === 0 && active.size === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve(stats());
    }
  }

  async function runTask(task) {
    const maxAttempts = (task.retries == null ? defaultRetries : task.retries) + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (stopped) break;
      try {
        task.attempt = attempt;
        const result = await execute(task, attempt);
        task.resolve && task.resolve(result);
        completed++;
        return { ok: true, result };
      } catch (err) {
        lastError = err;
        if (task.onAttemptFailed) {
          try { task.onAttemptFailed(err, attempt, maxAttempts); } catch { /* ignore */ }
        }
        const retryable = task.retryable === false ? false : !isFatal(err);
        if (!retryable || attempt === maxAttempts) break;
        await sleep(backoff(attempt));
      }
    }
    failed++;
    task.reject && task.reject(lastError);
    return { ok: false, error: lastError };
  }

  function pump() {
    while (!paused && !stopped && active.size < concurrency && pending.length) {
      const task = pending.shift();
      const promise = runTask(task)
        .catch(() => ({}))
        .finally(() => {
          active.delete(task.key);
          notify();
          queueMicrotask(pump);
        });
      active.set(task.key, promise);
      notify();
    }
  }

  return {
    add(tasks, extra = {}) {
      const list = Array.isArray(tasks) ? tasks : [tasks];
      for (const t of list) {
        const key = t.key != null ? t.key : `t${Math.random().toString(36).slice(2)}`;
        if (active.has(key) || pending.some(p => p.key === key)) continue;
        pending.push({ ...extra, ...t, key, attempt: 1 });
      }
      notify();
      pump();
      return stats();
    },

    /** 重新排入先前失敗的任務（retryFailed 由 pipeline 控制清單） */
    pause() {
      paused = true;
      notify();
    },

    resume() {
      paused = false;
      notify();
      pump();
    },

    stop() {
      stopped = true;
      pending.length = 0;
      notify();
    },

    setConcurrency(value) {
      concurrency = Math.max(1, Number(value) || 1);
      pump();
    },

    isPaused() {
      return paused;
    },

    stats,

    onIdle() {
      if (pending.length === 0 && active.size === 0) return Promise.resolve(stats());
      return new Promise(resolve => idleWaiters.push(resolve));
    },

    removePending(predicate) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (predicate(pending[i])) pending.splice(i, 1);
      }
      notify();
    },

    pendingKeys() {
      return pending.map(t => t.key);
    }
  };
}

function isFatal(err) {
  if (!err) return false;
  if (err.fatal === true) return true;
  const status = err.status;
  if (status === 400 || status === 413 || status === 415 || status === 401 || status === 403) return true;
  return false;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 分批並行執行（比 Promise.all 安全，並保留每批進度回報）。
 */
export async function runPool(items, worker, { concurrency = 4, onProgress } = {}) {
  const results = new Array(items.length);
  let index = 0;
  let done = 0;
  const runners = new Array(Math.min(concurrency, items.length || 1)).fill(null).map(async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      try {
        results[current] = { ok: true, value: await worker(items[current], current) };
      } catch (error) {
        results[current] = { ok: false, error };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}
