/*
 * 用「真實商品目錄」量測舊版配對成本（含 Fuse）
 *
 * 用法：
 *   node tools/bench-real-catalog.mjs                    # 直接讀取線上 /api/bootstrap
 *   node tools/bench-real-catalog.mjs products.json      # 或讀取本機 JSON（陣列，含 name/barcode）
 *
 * 只輸出時間統計，不會印出任何商品名稱或條碼。
 */

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
let Fuse = require('../vendor/fuse.min.js');
if (Fuse && Fuse.default) Fuse = Fuse.default;

const legacy = await import('./legacy/legacy-match.mjs');
const { buildIndex, matchFileName } = await import('../js/core/matcher.js');
const { makePdfFiles } = await import('./fixtures.mjs');

const source = process.argv[2] || 'https://product-label-app.pages.dev/api/bootstrap';
let products;
if (source.startsWith('http')) {
  const response = await fetch(source);
  const data = await response.json();
  products = data.products;
} else {
  const data = JSON.parse(await readFile(source, 'utf8'));
  products = Array.isArray(data) ? data : data.products;
}
console.log(`商品數：${products.length}`);

const files = makePdfFiles(products, 174, { seed: 2026, minSize: 60 * 1024, maxSize: 200 * 1024 });
const names = files.map(f => f.name.replace(/\.pdf$/i, ''));

/* 舊版：Fuse + 全庫掃描 */
legacy.setLegacyState(products.map(p => ({ ...p })), {});
const t0 = performance.now();
const fuse = new Fuse(products, {
  keys: [{ name: 'name', weight: 0.7 }, { name: 'barcode', weight: 0.15 }, { name: 'barcode2', weight: 0.15 }],
  threshold: 0.55, ignoreLocation: true, includeScore: true, minMatchCharLength: 2
});
const fuseBuild = performance.now() - t0;
legacy.setLegacyFuse(fuse);

const PROBE = Number(process.env.PROBE || 3);
const t1 = performance.now();
for (const name of names.slice(0, PROBE)) legacy.findBestMatch(name);
const legacyPerFile = (performance.now() - t1) / PROBE;

const t2 = performance.now();
legacy.setLegacyFuse(null);
for (const name of names.slice(0, PROBE)) legacy.findBestMatch(name);
const legacyNoFuse = (performance.now() - t2) / PROBE;

/* 新版：索引 + Worker 內同一套計分 */
const t3 = performance.now();
const index = buildIndex(products);
const buildMs = performance.now() - t3;
const t4 = performance.now();
let matched = 0;
for (const name of names) {
  const result = matchFileName(index, name, {});
  if (result && result.confidence !== 'low') matched++;
}
const newTotal = performance.now() - t4;

const fmt = n => `${n.toFixed(1)}ms`;
console.log(`
舊版（含 Fuse，實際生產行為）
  Fuse 索引建立        : ${fmt(fuseBuild)}
  每檔 findBestMatch   : ${fmt(legacyPerFile)}
  174 檔推算           : ${(legacyPerFile * 174 / 1000).toFixed(1)} 秒（全部在主執行緒）

舊版（不含 Fuse，只算 products.forEach + matchScore）
  每檔                 : ${fmt(legacyNoFuse)}
  174 檔推算           : ${(legacyNoFuse * 174 / 1000).toFixed(1)} 秒

新版（索引 + Worker）
  索引建立（一次）     : ${fmt(buildMs)}
  174 檔配對           : ${fmt(newTotal)}（每檔 ${(newTotal / 174).toFixed(2)}ms）
  配對成功             : ${matched} / 174
  相對舊版（含 Fuse）  : ${Math.round((legacyPerFile * 174) / newTotal)}× 快
`);
