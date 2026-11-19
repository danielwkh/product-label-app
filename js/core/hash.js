/*
 * 檔案指紋：用「大小 + 頭 / 中 / 尾各 128KB」取樣做 SHA-256。
 *
 * 為什麼不整份 hash：174 個 PDF 在 iPhone 上完整讀取可能超過 500MB，
 * 會造成明顯的記憶體壓力與 I/O。取樣 384KB 已足以區分實務上的 PDF。
 * 為什麼要 hash：讓同一個 PDF 在「重試 / 重新選擇 / 重新整理」後
 * 得到同一個 id，於是 IndexedDB、R2 key、D1 row 都不會重複累積。
 */
import { normalizeName } from './text.js';

const SAMPLE = 128 * 1024;

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }
  return out;
}

function fallbackDigest(bytes) {
  // FNV-1a 64-bit（crypto.subtle 不可用時的備援，只在極舊瀏覽器會用到）
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ bytes[i], 0x85ebca6b) + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export async function digestHex(bytes) {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    try {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return toHex(hash);
    } catch {
      /* fall through */
    }
  }
  return fallbackDigest(bytes);
}

export async function contentHash(file) {
  const size = file.size || 0;
  const parts = [new TextEncoder().encode(`plh1:${size}:`)];
  if (size <= SAMPLE * 2) {
    parts.push(await file.slice(0, size).arrayBuffer());
  } else {
    const mid = Math.max(SAMPLE, Math.floor(size / 2) - SAMPLE / 2);
    parts.push(await file.slice(0, SAMPLE).arrayBuffer());
    parts.push(await file.slice(mid, mid + SAMPLE).arrayBuffer());
    parts.push(await file.slice(size - SAMPLE, size).arrayBuffer());
  }
  return digestHex(concat(parts));
}

/** 名稱的穩定短雜湊，用來區分「同內容、不同檔名」的標籤。 */
export function nameHash(name) {
  const text = normalizeName(name);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 穩定的標籤 id：同一個 PDF（內容 + 檔名）永遠得到同一個 id。 */
export function makeLabelId(hash, name) {
  return `L${hash.slice(0, 20)}-${nameHash(name).slice(0, 6)}`;
}
