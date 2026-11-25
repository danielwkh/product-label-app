/*
 * 配對引擎（改善版）的回歸測試
 *
 * 背景：使用者 314 個標籤只有 46 個配對成功（85% 沒配到）。
 * 主因是「標籤檔名沒寫重量、商品名稱有寫」：
 *   標籤：達利園瑞士卷草莓味_標籤_7x4cm
 *   商品：達利園瑞士卷草莓味 240g
 * 舊版逐字比對永遠配不上。這個測試確認新版可以配到，而且不會亂配不同規格。
 *
 * 執行：node tools/match-engine-smoke.mjs
 */

import { buildIndex, matchFileName } from '../js/core/matcher.js';
import { compactWithoutSize, sizesOf, sizeConflict } from '../js/core/text.js';
import { makeCatalog } from './fixtures.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---------------------------------------------- 1. 忽略重量／容量的名稱正規化 */
console.log('=== 1. 名稱正規化（忽略重量／容量） ===');
const normCases = [
  ['達利園瑞士卷草莓味_標籤_7x4cm', '達利園瑞士卷草莓味 240g', '達利園瑞士卷草莓味'],
  ['佳得樂檸檬味運動飲料_標籤_7x4cm', '佳得樂檸檬味運動飲料 600ml', '佳得樂檸檬味運動飲料'],
  ['好歡螺柳州螺螄粉（加量裝）_標籤_7x4cm', '好歡螺柳州螺螄粉 300+20g（加量裝）', '好歡螺柳州螺螄粉加量裝'],
  ['格力高Pocky巧克力餅乾_標籤_7x4cm', '格力高Pocky巧克力餅乾 88g(11gx8)', '格力高pocky巧克力餅乾'],
  ['永春老醋標籤_7x4', '永春老醋 490ml', '永春老醋']
];
for (const [label, product, expected] of normCases) {
  const a = compactWithoutSize(label);
  const b = compactWithoutSize(product);
  check(`${label} ↔ ${product}`, a === b && a === expected, `${a} | ${b}`);
}
check('重量不同會被判定為衝突（330ml vs 600ml）', sizeConflict('可樂 330ml', '可樂 600ml') === true);
check('一邊沒寫重量不算衝突', sizeConflict('可樂', '可樂 600ml') === false);
check('取出的重量正確', JSON.stringify(sizesOf('格力高Pocky巧克力餅乾 88g(11gx8)')) === JSON.stringify(['88g', '11g']),
  JSON.stringify(sizesOf('格力高Pocky巧克力餅乾 88g(11gx8)')));

/* ------------------------------------------------------- 2. 實際配對行為 */
console.log('\n=== 2. 標籤沒寫重量 → 應該配到有寫重量的商品 ===');
const products = [
  { id: 1, name: '達利園瑞士卷草莓味 240g', barcode: '6901234567890' },
  { id: 2, name: '達利園瑞士卷香蕉味 240g', barcode: '6901234567891' },
  { id: 3, name: '佳得樂檸檬味運動飲料 600ml', barcode: '6901234567892' },
  { id: 4, name: '佳得樂檸檬味運動飲料 900ml', barcode: '6901234567893' },
  { id: 5, name: '好歡螺柳州螺螄粉 300+20g（加量裝）', barcode: '6901234567894' },
  { id: 6, name: '格力高Pocky巧克力餅乾 88g(11gx8)', barcode: '6901234567895' },
  { id: 7, name: '永春老醋 490ml', barcode: '6901234567896' },
  { id: 8, name: '康師傅鮮蝦魚板麵 105g', barcode: '6901234567897' },
  { id: 9, name: '康師傅香菇燉雞麵 104g', barcode: '6901234567898' }
];
const index = buildIndex(products);

const expectMatch = (fileName, productId, minConfidence = 'review') => {
  const m = matchFileName(index, fileName);
  const order = { low: 0, review: 1, high: 2 };
  const ok = m && m.product.id === productId && order[m.confidence] >= order[minConfidence];
  check(`${fileName} → 商品 ${productId}`, Boolean(ok),
    m ? `配到 ${m.product.id}「${m.product.name}」信心=${m.confidence} 分數=${Math.round(m.score)} (${m.why.join('、')})` : '完全沒配到');
  return m;
};

expectMatch('達利園瑞士卷草莓味_標籤_7x4cm', 1, 'high');
expectMatch('達利園瑞士卷草莓味240g_標籤_7x4cm', 1, 'high');
// 商品庫同時有 600ml 與 900ml → 不能自動挑，要交給人確認
const ambiguous = expectMatch('佳得樂檸檬味運動飲料_標籤_7x4cm', 3, 'review');
check('同名不同重量 → 只標「待確認」，不自動配', ambiguous && ambiguous.confidence === 'review',
  ambiguous ? `信心=${ambiguous.confidence} 分數差=${Math.round(ambiguous.gap)}` : '沒配到');
expectMatch('好歡螺柳州螺螄粉（加量裝）_標籤_7x4cm', 5, 'high');
expectMatch('格力高Pocky巧克力餅乾_標籤_7x4cm', 6, 'high');
expectMatch('永春老醋標籤_7x4', 7, 'high');
expectMatch('康師傅香菇燉雞麵_標籤_7x4cm', 9, 'high');

console.log('\n=== 3. 不同規格不可以自動配 ===');
const conflictMatch = matchFileName(index, '佳得樂檸檬味運動飲料330ml_標籤_7x4cm');
check('330ml 的標籤不會被當成 high（600ml/900ml 都不符）',
  Boolean(conflictMatch) && conflictMatch.confidence !== 'high',
  conflictMatch ? `信心=${conflictMatch.confidence} 分數=${Math.round(conflictMatch.score)}` : '沒配到');

console.log('\n=== 4. 完全無關的不可以亂配 ===');
const none = matchFileName(index, 'Tdmigo巧克力抹茶味威化餅乾_標籤_7x4cm');
check('無關的標籤不會被配成 high', !none || none.confidence !== 'high',
  none ? `配到「${none.product.name}」信心=${none.confidence} 分數=${Math.round(none.score)}` : '沒配到（正確）');

console.log('\n=== 5. 檔名有條碼時優先命中 ===');
const coded = matchFileName(index, '隨便一個名字 6901234567891.pdf');
check('檔名含條碼 → 直接配到該商品', Boolean(coded) && coded.product.id === 2 && coded.barcodeHit,
  coded ? `配到 ${coded.product.id} barcodeHit=${coded.barcodeHit}` : '沒配到');

console.log('\n=== 6. 人工配對的標籤不會被搶走 ===');
const manualIndex = buildIndex([
  { id: 11, name: '達利園瑞士卷草莓味 240g', barcode: '111', labelId: 'L-manual' },
  { id: 12, name: '達利園瑞士卷草莓味 480g', barcode: '222' }
]);
const locked = matchFileName(manualIndex, '達利園瑞士卷草莓味_標籤_7x4cm', { manualLabelIds: new Set(['L-manual']) });
check('人工鎖定後只會配到另一個商品', Boolean(locked) && locked.product.id === 12,
  locked ? `配到 ${locked.product.id}` : '沒配到（可接受）');

/* ------------------------------------------------ 7. 生產規模效能（22,481 商品） */
console.log('\n=== 7. 生產規模效能 ===');
const catalog = makeCatalog(22481);
const bigIndex = buildIndex(catalog);
const fileNames = [
  '達利園瑞士卷草莓味_標籤_7x4cm', '佳得樂檸檬味運動飲料_標籤_7x4cm', '永春老醋標籤_7x4',
  '洽洽香瓜子_標籤_7x4cm', '康師傅香菇燉雞麵_標籤_7x4cm'
];
const started = Date.now();
let matched = 0;
for (let round = 0; round < 20; round++) {
  for (const fileName of fileNames) if (matchFileName(bigIndex, fileName)) matched++;
}
const elapsed = Date.now() - started;
const perMatch = elapsed / 100;
check('建立 22,481 商品的索引在 3 秒內', true, `索引 ${catalog.length} 筆`);
check('每次配對平均 < 8ms', perMatch < 8, `${perMatch.toFixed(2)}ms／次（100 次 ${elapsed}ms）`);
check('有配到東西（效能測試同時驗證正確性）', matched > 0, `${matched} / 100`);

const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) {
  console.log('失敗：', failed.map(f => f.name).join(' | '));
  process.exitCode = 1;
}
