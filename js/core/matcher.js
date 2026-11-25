/*
 * 自動配對核心（純函式，無 DOM 依賴）
 *
 * 舊版的問題：findBestMatch() 對「每一個 PDF」都 products.forEach 掃描全部商品，
 * 並對每個商品重新做 normalize / compact / tokenize / dice（全部是 regex 與字串配置），
 * 因此成本是 O(PDF 數 × 商品數)。5,000 個商品 × 174 個 PDF 約等於 87 萬次
 * matchScore，在 iPhone 上會在主執行緒連續卡住數十秒到數分鐘。
 *
 * 這個版本改成：
 *   1. 建立索引時，每個商品只做一次正規化與預處理。
 *   2. 配對時先用「條碼尾 6 碼索引」與「字元 bigram 倒排索引」取出少量候選，
 *      再對候選計分（與舊版分數公式完全相同）。
 *   成本變成 O(PDF 數 × 檔名長度 + 候選數)。
 */

import {
  normalizeName,
  normalize,
  compact,
  compactWithoutSize,
  sizesOf,
  sizeConflict,
  digits,
  barcodeTail6,
  isBarcodeQuery,
  barcodeMatchesTail,
  tokens,
  prepDice,
  dicePrepared,
  bigramsOf
} from './text.js';

const MAX_CANDIDATES = 400;

export function prepareProduct(p) {
  const name = String(p && p.name != null ? p.name : '');
  const pn = compact(name);
  const required = tokens(name).map(compact).filter(x => x.length >= 2);
  const codes = [p && p.barcode, p && p.barcode2]
    .map(c => digits(c))
    .filter(c => c.length >= 6);
  const pnU = compactWithoutSize(name);          // 去掉重量／容量後的名稱（配對主力）
  return {
    id: p ? p.id : undefined,
    name,
    barcode: (p && p.barcode) || '',
    barcode2: (p && p.barcode2) || '',
    labelId: (p && p.labelId) || null,
    pn,
    pnU,
    sizes: sizesOf(name),
    nameLen: pn.length,
    dice: prepDice(name),
    diceU: prepDice(pnU || name),
    required,
    requiredU: tokens(pnU || name).map(compact).filter(x => x.length >= 2),
    codes
  };
}

export function buildIndex(products) {
  const list = Array.isArray(products) ? products : [];
  const items = new Array(list.length);
  const byId = new Map();
  const byTail6 = new Map();
  const byBigram = new Map();
  const byBigramU = new Map();
  const byToken = new Map();

  const push = (map, key, idx) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(idx);
    else map.set(key, [idx]);
  };

  for (let i = 0; i < list.length; i++) {
    const item = prepareProduct(list[i]);
    items[i] = item;
    if (item.id != null) byId.set(item.id, item);

    for (const code of item.codes) {
      const tail = code.slice(-6);
      const bucket = byTail6.get(tail);
      if (bucket) {
        if (!bucket.includes(i)) bucket.push(i);
      } else byTail6.set(tail, [i]);
    }

    if (item.pnU) {
      for (const g of bigramsOf(item.pnU)) push(byBigramU, g, i);
    }
    if (item.pn) {
      for (const g of bigramsOf(item.pn)) push(byBigram, g, i);
      const seenTokens = new Set();
      for (const tk of tokens(item.name)) {
        if (tk.length < 2 || seenTokens.has(tk)) continue;
        seenTokens.add(tk);
        push(byToken, tk, i);
      }
    }
  }

  return { items, byId, byTail6, byBigram, byBigramU, byToken, size: items.length };
}

function fileContext(fileName) {
  const raw = normalizeName(fileName);
  const fnU = compactWithoutSize(fileName);
  return {
    raw,
    fn: compact(fileName),
    fnU,
    fd: digits(fileName),
    sizes: sizesOf(fileName),
    dice: prepDice(raw),
    diceU: prepDice(fnU || raw),
    rawLen: raw.length
  };
}

/** 與舊版 matchScore(fileName, product) 完全相同的計分公式。 */
function scorePrepared(ctx, item) {
  const pn = item.pn;
  if (!ctx.raw || !pn) return { score: 0, why: [], barcodeHit: false, coverage: 0 };

  let score = 0;
  const why = [];
  let barcodeHit = false;

  if (item.codes.some(code => ctx.fd.includes(code))) {
    score += 1000;
    barcodeHit = true;
    why.push('檔名含條碼');
  }
  if (ctx.fn === pn) {
    score += 500;
    why.push('名稱完全相同');
  } else if (ctx.fn.includes(pn) || pn.includes(ctx.fn)) {
    score += 260;
    why.push('名稱互相包含');
  } else if (ctx.fnU && item.pnU && ctx.fnU === item.pnU) {
    // 標籤檔名沒寫重量、商品名稱有寫（例如「草莓味」對「草莓味 240g」）
    score += 430;
    why.push('名稱相同（忽略重量）');
  } else if (ctx.fnU && item.pnU && (ctx.fnU.includes(item.pnU) || item.pnU.includes(ctx.fnU))) {
    score += 240;
    why.push('名稱互相包含（忽略重量）');
  }

  let coverage = 0;
  if (item.required.length) {
    let hit = 0;
    for (const token of item.required) if (ctx.fn.includes(token)) hit++;
    coverage = hit / item.required.length;
  }
  // 忽略重量的關鍵詞命中（商品「草莓味 240g」的 240g 不應該扣分）
  let coverageU = 0;
  if (item.requiredU && item.requiredU.length) {
    let hitU = 0;
    for (const token of item.requiredU) if (ctx.fnU.includes(token)) hitU++;
    coverageU = hitU / item.requiredU.length;
  }
  coverage = Math.max(coverage, coverageU || 0);
  score += coverage * 180;
  if (coverage >= 0.8) why.push(`關鍵詞命中 ${Math.round(coverage * 100)}%`);

  const d = Math.max(dicePrepared(ctx.dice, item.dice), dicePrepared(ctx.diceU, item.diceU));
  score += d * 100;
  if (d >= 0.75) why.push('名稱高度相似');

  const lengthRatio = Math.min(ctx.rawLen, item.nameLen) / Math.max(ctx.rawLen, item.nameLen, 1);
  score += lengthRatio * 35;

  // 兩邊都寫了重量但不同（例如 330ml vs 600ml）→ 很可能不是同一支商品，降分並標記
  const conflict = sizeConflict(ctx.raw, item.name);
  if (conflict) {
    score *= 0.55;
    why.push('重量／容量不同');
  }

  return { score, why, barcodeHit, coverage, sizeConflict: conflict };
}

function collectCandidates(index, ctx) {
  const hits = new Map();
  const bump = (idx, weight) => hits.set(idx, (hits.get(idx) || 0) + weight);

  // 1) 條碼：檔名中的數字只要能包含某商品完整條碼，直接成為高權重候選
  if (ctx.fd.length >= 6) {
    const seen = new Set();
    for (let i = 0; i + 6 <= ctx.fd.length; i++) {
      const tail = ctx.fd.slice(i, i + 6);
      const bucket = index.byTail6.get(tail);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        const item = index.items[idx];
        if (item.codes.some(code => ctx.fd.includes(code))) {
          seen.add(idx);
          bump(idx, 50);
        }
      }
    }
  }

  // 2) 字元 bigram 倒排索引：中英文檔名都能有效命中
  if (ctx.fn) {
    for (const g of bigramsOf(ctx.fn)) {
      const bucket = index.byBigram.get(g);
      if (!bucket) continue;
      for (const idx of bucket) bump(idx, 1);
    }
  }

  // 2b) 忽略重量／容量的 bigram（標籤沒寫 240g 時也要找得到）
  if (ctx.fnU) {
    for (const g of bigramsOf(ctx.fnU)) {
      const bucket = index.byBigramU.get(g);
      if (!bucket) continue;
      for (const idx of bucket) bump(idx, 1);
    }
  }

  // 3) 空白分隔的詞
  for (const tk of tokens(ctx.raw)) {
    const bucket = index.byToken.get(tk);
    if (!bucket) continue;
    for (const idx of bucket) bump(idx, 3);
  }

  return hits;
}

function rankByHits(hits, limit) {
  if (hits.size <= limit) return [...hits.keys()];
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(entry => entry[0]);
}

/**
 * @param {object} index buildIndex() 的結果
 * @param {string} fileName 檔名或商品名稱
 * @param {object} [opts]
 * @param {Set<string>} [opts.manualLabelIds] 已人工配對的 label id（其他商品不可搶走）
 * @param {string} [opts.currentLabelId] 目前這張標籤的 id
 * @param {number} [opts.maxCandidates]
 * @returns {null | {product, score, why, barcodeHit, coverage, gap, confidence, secondBest}}
 */
export function matchFileName(index, fileName, opts = {}) {
  const ctx = fileContext(fileName);
  if (!ctx.raw) return null;
  const manualLabelIds = opts.manualLabelIds || new Set();
  const currentLabelId = opts.currentLabelId || null;

  const hits = collectCandidates(index, ctx);
  if (!hits.size) return null;

  const candidates = rankByHits(hits, opts.maxCandidates || MAX_CANDIDATES);
  const ranked = [];
  for (const idx of candidates) {
    const item = index.items[idx];
    if (item.labelId && item.labelId !== currentLabelId && manualLabelIds.has(item.labelId)) continue;
    const scored = scorePrepared(ctx, item);
    ranked.push({ product: item, ...scored });
  }
  if (!ranked.length) return null;

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const gap = best.score - (second ? second.score : 0);
  let confidence =
    best.barcodeHit || best.score >= 500 || (best.score >= 330 && gap >= 70)
      ? 'high'
      : best.score >= 180 && gap >= 30
        ? 'review'
        : 'low';
  // 兩個候選分數幾乎一樣（例如同名不同重量）→ 不要亂挑，交給人確認
  const ambiguous = Boolean(second) && (best.score - second.score) < 40;
  if (ambiguous && !best.barcodeHit) confidence = confidence === 'high' ? 'review' : confidence;
  // 重量不同就交給人看，不要自動配（避免把 330ml 配到 600ml）
  if (best.sizeConflict && confidence === 'high') confidence = 'review';
  return { ...best, secondBest: second, gap, confidence };
}

/** 互動式搜尋（條碼尾 6 碼 / 商品名稱），給搜尋頁與手動配對視窗使用。 */
export function searchProducts(index, query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (isBarcodeQuery(q) && digits(q).length >= 6) {
    const tail = barcodeTail6(q);
    const out = [];
    const seen = new Set();
    for (const idx of index.byTail6.get(tail) || []) {
      const item = index.items[idx];
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out.slice(0, limit * 2);
  }
  const ctx = fileContext(q);
  const hits = collectCandidates(index, ctx);
  const ranked = [];
  for (const idx of rankByHits(hits, MAX_CANDIDATES)) {
    const item = index.items[idx];
    const scored = scorePrepared(ctx, item);
    if (scored.score > 40) ranked.push({ item, score: scored.score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(x => x.item);
}

/** 僅供測試 / 除錯：暴力比對（等於舊版行為），用來驗證索引候選沒有漏掉最佳解。 */
export function bruteForceMatchIndexed(index, fileName, opts = {}) {
  return brute(index, fileName, opts);
}

function brute(index, fileName, opts) {
  const ctx = fileContext(fileName);
  const manualLabelIds = opts.manualLabelIds || new Set();
  const currentLabelId = opts.currentLabelId || null;
  const ranked = [];
  for (const item of index.items) {
    if (!item.pn) continue;
    if (item.labelId && item.labelId !== currentLabelId && manualLabelIds.has(item.labelId)) continue;
    ranked.push({ product: item, ...scorePrepared(ctx, item) });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const gap = best.score - (second ? second.score : 0);
  let confidence =
    best.barcodeHit || best.score >= 500 || (best.score >= 330 && gap >= 70)
      ? 'high'
      : best.score >= 180 && gap >= 30
        ? 'review'
        : 'low';
  // 兩個候選分數幾乎一樣（例如同名不同重量）→ 不要亂挑，交給人確認
  const ambiguous = Boolean(second) && (best.score - second.score) < 40;
  if (ambiguous && !best.barcodeHit) confidence = confidence === 'high' ? 'review' : confidence;
  // 重量不同就交給人看，不要自動配（避免把 330ml 配到 600ml）
  if (best.sizeConflict && confidence === 'high') confidence = 'review';
  return { ...best, secondBest: second, gap, confidence };
}

export { normalize, normalizeName, compact, digits, barcodeTail6, isBarcodeQuery, barcodeMatchesTail };
