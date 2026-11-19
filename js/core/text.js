/*
 * 純字串處理工具（與舊版 index.html 完全相同的正規化行為）
 * 這個檔案沒有任何瀏覽器 API 依賴，可以在 Web Worker 或 Node 測試中直接 import。
 */

export const FILENAME_NOISE = /\b(copy|final|new|新版|標籤|營養標示|nutrition|label|商品|產品)\b/gi;

export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/\.(xlsx?|csv)$/i, '')
    .replace(FILENAME_NOISE, ' ')
    .replace(/[_\-—–|/]+/g, ' ')
    .replace(/[，。、「」『』【】［］]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalize(s) {
  return normalizeName(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function compact(s) {
  return normalizeName(s).replace(/[^\p{L}\p{N}]/gu, '');
}

export function digits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

export function barcodeTail6(s) {
  const value = digits(s);
  return value.length >= 6 ? value.slice(-6) : value;
}

export function isBarcodeQuery(s) {
  const value = String(s ?? '').trim();
  return value.length > 0 && !/\p{L}/u.test(value) && digits(value).length > 0;
}

export function barcodeMatchesTail(product, tail) {
  return [product.barcode, product.barcode2].some(code => {
    const value = digits(code);
    return value.length >= 6 && value.endsWith(tail);
  });
}

export function tokens(s) {
  return normalizeName(s).split(/\s+/).filter(x => x.length >= 2);
}

/**
 * 把字串預先轉成 dice 係數所需要的形式。
 * 舊版 dice() 每次呼叫都會重新 tokenize / 建立 bigram Set，
 * 商品庫大時這是 O(檔案數 × 商品數) 的主要成本。預先算好後，
 * 每次配對只需要做集合交集。
 */
export function prepDice(s) {
  const raw = String(s ?? '');
  const tk = tokens(raw);
  const parts = tk.length > 1 ? tk : [...raw];
  const charMode = parts.length === 1;
  const char = charMode ? parts[0] : '';
  return {
    raw,
    parts,
    set: new Set(parts),
    charMode,
    char,
    bigrams: charMode ? bigramSequence(char) : null
  };
}

function bigramSequence(text) {
  const seq = [];
  for (let i = 0; i < text.length - 1; i++) seq.push(text.slice(i, i + 2));
  return seq;
}

/**
 * 與舊版 dice(a,b) 數值完全相同，但兩邊的字串已在建立索引時預處理過，
 * 因此每次配對只剩集合運算（不必再 tokenize、normalize、建 Set）。
 */
export function dicePrepared(a, b) {
  if (!a || !b) return 0;
  if (a.raw === b.raw) return 1;
  if (a.parts.length === 1 && b.parts.length === 1) {
    const x = a.char, y = b.char;
    if (x.length < 2 || y.length < 2) return 0;
    const grams = new Set(a.bigrams);
    let hit = 0;
    for (const g of b.bigrams) if (grams.has(g)) hit++;
    return (2 * hit) / (x.length + y.length);
  }
  const sa = a.set, sb = b.set;
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const v of sa) if (sb.has(v)) hit++;
  return (2 * hit) / (sa.size + sb.size);
}

/** 舊版介面，保留給測試與向後相容使用。 */
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return dicePrepared(prepDice(a), prepDice(b));
}

export function tokenCoverage(fileName, productName) {
  const fileText = compact(fileName);
  const required = tokens(productName).map(compact).filter(x => x.length >= 2);
  if (!required.length) return 0;
  return required.filter(token => fileText.includes(token)).length / required.length;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function bigramsOf(text) {
  const out = new Set();
  if (!text) return out;
  if (text.length === 1) {
    out.add(text);
    return out;
  }
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

export function looksLikeCJK(s) {
  return CJK.test(s);
}
