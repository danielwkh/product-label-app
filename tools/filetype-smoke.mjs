/*
 * 「支援 PDF 以外格式」測試（.wdfx 這類 WePrint 讀得到的檔案）
 *
 * 驗證：
 *   1. 用檔頭判斷格式（不是靠副檔名）：PDF 改名成 .wdfx 也能預覽
 *   2. 圖片可以直接預覽
 *   3. 真正的未知格式：照樣保存、上傳、分享，只是不在站內預覽
 *   4. 上傳時會帶正確的 mime / ext（WePrint 才認得）
 *   5. 分享出去的檔案保留原始檔名與類型
 *
 * 執行：node tools/filetype-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { sniffFile, stripExtension, extFromName } from '../js/core/filetype.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------ 1. 檔頭判斷（純函式） */
console.log('=== 1. 檔頭判斷 ===');
const pdfBytes = new TextEncoder().encode('%PDF-1.7\n% test\n%%EOF');
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const weirdBytes = new Uint8Array([0x57, 0x44, 0x46, 0x58, 0x01, 0x02, 0x03, 0x04]); // 魔改的 "WDFX"

const sniff = async (bytes, name) => sniffFile(new File([bytes], name));

const pdfAsWdfx = await sniff(pdfBytes, '洗髮精.wdfx');
check('PDF 改名成 .wdfx → 仍判定為 PDF', pdfAsWdfx.kind === 'pdf' && pdfAsWdfx.mime === 'application/pdf',
  JSON.stringify(pdfAsWdfx));
const png = await sniff(pngBytes, 'label.png');
check('PNG → 圖片', png.kind === 'image' && png.mime === 'image/png', JSON.stringify(png));
const jpeg = await sniff(jpegBytes, 'photo.jpg');
check('JPEG → 圖片', jpeg.kind === 'image' && jpeg.mime === 'image/jpeg', JSON.stringify(jpeg));
const docx = await sniff(zipBytes, '報價單.docx');
check('DOCX（ZIP 檔頭）→ 一般檔案', docx.kind === 'file' && /wordprocessingml/.test(docx.mime), JSON.stringify(docx));
const weird = await sniff(weirdBytes, '標籤.wdfx');
check('未知格式 → 一般檔案（保留原檔）', weird.kind === 'file' && weird.ext === 'wdfx', JSON.stringify(weird));

check('stripExtension 去掉任何副檔名', stripExtension('洗髮精 400ml.wdfx') === '洗髮精 400ml', stripExtension('洗髮精 400ml.wdfx'));
check('extFromName 取得副檔名', extFromName('A.WDFX') === 'wdfx');

/* ------------------------------------------------------- 2. 瀏覽器環境 */
console.log('\n=== 2. 匯入流程（JSDOM）===');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), {
  url: 'https://product-label-app.pages.dev/', runScripts: 'outside-only', pretendToBeVisual: true
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
Object.defineProperty(globalThis.navigator, 'storage', {
  value: { estimate: async () => ({ quota: 4 * 1024 * 1024 * 1024, usage: 0 }), persist: async () => true },
  configurable: true
});
Object.defineProperty(globalThis.navigator, 'share', { value: undefined, configurable: true });
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Worker = undefined;
globalThis.confirm = () => true;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => `blob:test-${Math.random().toString(16).slice(2)}`;
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
let fetchCalls = [];
globalThis.fetch = async () => { throw new Error('離線測試環境'); };

const app = await import('../js/app.js');
await wait(150);
const state = window.app.state;
const db = await import('../js/store/db.js');
const pipeline = window.app.pipeline;

const bigPdf = new Uint8Array(4096);
bigPdf.set(pdfBytes, 0);
const files = [
  new File([bigPdf], '洗髮精 400ml.wdfx', { type: '', lastModified: 1763100000000 }),
  new File([pngBytes], '貨架照片.png', { type: 'image/png', lastModified: 1763100001000 }),
  new File([weirdBytes], '神秘標籤.wdfx', { type: '', lastModified: 1763100002000 })
];

pipeline.setProducts([]);
pipeline.setLabels({});
await pipeline.decideStorageMode();
const intake = await pipeline.intake(files);
check('3 個檔案全部收下（不再用副檔名過濾）', intake.added === 3, `added=${intake.added}`);
const jobs = pipeline.getJobs();
check('job 上記錄了格式', jobs.every(j => j.kind), jobs.map(j => `${j.name}:${j.kind}`).join(', '));

await pipeline.start();
let waited = 0;
while (waited < 20000) {
  const statuses = pipeline.getJobs().map(j => j.status);
  if (statuses.every(s => ['ready', 'done', 'duplicate', 'failed'].includes(s))) break;
  await wait(100);
  waited += 100;
}
await wait(150);

state.labels = pipeline.getLabels();   // pipeline 是本機階段唯一真相，畫面靠這個同步
const labels = Object.values(state.labels);
check('3 筆標籤都建立', labels.length === 3, `${labels.length}`);
check('本機 Blob 都寫入（可離線預覽）', labels.every(l => l.hasLocalBlob), labels.map(l => l.hasLocalBlob).join(','));
const byName = name => labels.find(l => (l.filename || '').includes(name));
const pdfLabel = byName('洗髮精 400ml');
const imgLabel = byName('貨架照片');
const weirdLabel = byName('神秘標籤');

check('PDF 偽裝成 .wdfx 的標籤判定為 pdf', pdfLabel && pdfLabel.kind === 'pdf', pdfLabel && pdfLabel.kind);
check('顯示名稱去掉 .wdfx 副檔名', pdfLabel && pdfLabel.nameFromFile === '洗髮精 400ml', pdfLabel && pdfLabel.nameFromFile);
check('原始檔名保留（分享給 WePrint 要用原名）', pdfLabel && pdfLabel.filename === '洗髮精 400ml.wdfx');
check('圖片標籤判定為 image', imgLabel && imgLabel.kind === 'image', imgLabel && imgLabel.kind);
check('未知格式判定為 file', weirdLabel && weirdLabel.kind === 'file', weirdLabel && weirdLabel.kind);

/* ------------------------------------------------------- 3. 站內預覽行為 */
console.log('\n=== 3. 站內預覽 ===');
await window.app.previewLabel(imgLabel.id);
await wait(80);
const imgStage = document.getElementById('previewStage').innerHTML;
check('圖片會直接顯示（<img>）', /<img /.test(imgStage), imgStage.slice(0, 60).replace(/\n/g, ' '));
window.app.state.preview.pdf = null;

await window.app.previewLabel(weirdLabel.id);
await wait(80);
const weirdStage = document.getElementById('previewStage').innerHTML;
check('未知格式顯示「無法在網站內預覽」', /無法在網站內預覽/.test(weirdStage), weirdStage.slice(0, 80).replace(/\n/g, ' '));
check('並提示可直接分享到 WePrint', /WePrint/.test(weirdStage));

/* ------------------------------------------------- 4. 上傳會帶 mime / ext */
console.log('\n=== 4. 上傳內容與分享 ===');
const { createApi } = await import('../js/store/api.js');
fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const api = createApi({ base: './api/' });
await api.uploadLabel(weirdLabel, new File([weirdBytes], '神秘標籤.wdfx', { type: '' }));
const form = fetchCalls[0].init.body;
check('表單有帶 mime', form.get('mime') === 'application/octet-stream', form.get('mime'));
check('表單有帶 ext = wdfx', form.get('ext') === 'wdfx', form.get('ext'));
check('表單有帶原始檔名', form.get('filename') === '神秘標籤.wdfx', form.get('filename'));

let sharedFile = null;
Object.defineProperty(globalThis.navigator, 'share', {
  value: async payload => { sharedFile = payload.files[0]; }, configurable: true
});
Object.defineProperty(globalThis.navigator, 'canShare', { value: () => true, configurable: true });
await window.app.shareLabel(pdfLabel.id);
check('分享出去的檔名保留 .wdfx', sharedFile && sharedFile.name === '洗髮精 400ml.wdfx', sharedFile && sharedFile.name);
check('分享出去的類型是 PDF（WePrint 靠這個判斷）', sharedFile && sharedFile.type === 'application/pdf', sharedFile && sharedFile.type);

/* --------------------------------------------------------- 結果 */
const failed = results.filter(r => !r.ok);
console.log(`\n=== 結果：${results.length - failed.length} / ${results.length} 通過 ===`);
if (failed.length) {
  console.log('失敗：', failed.map(f => `${f.name}（${f.detail}）`).join(' | '));
  process.exitCode = 1;
}
