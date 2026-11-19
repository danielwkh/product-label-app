/* 測試資料產生器：可重現的商品目錄與 PDF 檔案（固定種子，每次都一樣） */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS = ['義美', '統記', '廣達香', '泰山', '光泉', '味全', '聯華', '宏亞', '福義軒', '佳德', '維力', '金車'];
const CATEGORY = ['小泡芙', '蘇打餅', '蛋捲', '鳳梨酥', '米果', '豆漿', '燕麥飲', '肉鬆', '魚鬆', '巧克力', '蘇打汽水', '高山茶', '蜂蜜蛋糕', '太陽餅', '牛軋糖'];
const FLAVOR = ['原味', '巧克力', '草莓', '抹茶', '芝麻', '海苔', '椒鹽', '蜂蜜', '黑糖', '蒜味', '起司', '香草'];
const PACK = ['65g', '120g', '180g', '250ml', '330ml', '600ml', '12入', '6入', '家庭號', '量販包'];
const EXTRA = ['', '', '', '', '禮盒', '分享包', '隨手包', '特惠組', '箱購', '補充包'];

/** 產生 size 個商品（同一個 seed → 同一份目錄） */
export function makeCatalog(size = 5000, seed = 20261119) {
  const rand = mulberry32(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const products = [];
  const seen = new Set();
  let id = 1;
  let guard = 0;
  while (products.length < size) {
    guard++;
    let name = `${pick(BRANDS)} ${pick(CATEGORY)} ${pick(FLAVOR)} ${pick(PACK)}${pick(EXTRA)}`;
    // 名稱組合用盡時加上序號，避免無窮迴圈
    if (guard > size * 40) name = `${name} ${products.length + 1}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const barcode = String(4710000000000 + Math.floor(rand() * 899999999));
    const barcode2 = rand() > 0.65 ? String(2000000000000 + Math.floor(rand() * 799999999)) : '';
    products.push({ id: id++, name, barcode, barcode2, labelId: null });
  }
  return products;
}

function makePdfBytes(size, marker) {
  const head = new TextEncoder().encode(`%PDF-1.7\n%fixture ${marker}\n`);
  const bytes = new Uint8Array(size);
  bytes.set(head, 0);
  // 用 marker 的 hash 填充可壓縮的假資料，讓每個檔案內容不同
  let x = 0;
  for (let i = 0; i < marker.length; i++) x = (x * 31 + marker.charCodeAt(i)) >>> 0;
  for (let i = head.length; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    bytes[i] = x & 0xff;
  }
  const tail = new TextEncoder().encode('\n%%EOF');
  bytes.set(tail, size - tail.length);
  return bytes;
}

/**
 * 產生 count 個 PDF File 物件。
 * 檔名分佈模擬實際使用情況：完全同名、帶雜訊後綴、檔名含條碼、以及少量對不到商品的檔名。
 */
export function makePdfFiles(catalog, count = 174, options = {}) {
  const { seed = 4711, minSize = 80 * 1024, maxSize = 1800 * 1024, unmatchedRatio = 0.12 } = options;
  const rand = mulberry32(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const files = [];
  for (let i = 0; i < count; i++) {
    const useUnmatched = rand() < unmatchedRatio;
    const product = useUnmatched ? null : catalog[Math.floor(rand() * catalog.length)];
    const style = rand();
    let name;
    if (!product) {
      name = `未建檔商品 ${1000 + i} 神秘口味 測試.pdf`;
    } else if (style < 0.55) {
      name = `${product.name}.pdf`;
    } else if (style < 0.8) {
      name = `${product.name}-營養標示.pdf`;
    } else if (style < 0.92) {
      name = `${product.barcode}_${product.name}.pdf`;
    } else {
      name = `${product.name} copy 新版.pdf`;
    }
    const size = Math.floor(minSize + rand() * (maxSize - minSize));
    const bytes = makePdfBytes(size, `${name}:${i}`);
    files.push(new File([bytes], name, { type: 'application/pdf', lastModified: 1763000000000 + i * 1000 }));
  }
  return files;
}

export function totalBytes(files) {
  return files.reduce((sum, f) => sum + f.size, 0);
}
