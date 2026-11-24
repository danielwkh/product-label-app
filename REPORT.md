# 商品標籤助手 — 174 個 PDF 卡住問題：完整診斷與重構報告

- 分析對象：`danielwkh/product-label-app` `main` @ `9e0352f`（"Persist only new PDF batches"，2026-11-19）
- 本報告產出的程式碼：同一個 repository 的修改版（見「檔案清單」）
- 測試環境：Node 20.20.2 + fake-indexeddb + JSDOM + Miniflare（D1/R2 模擬）
- 未動到任何 D1 / R2 既有資料；所有遷移都是「只新增欄位」

---

## 0. 結論先講

### 0.1 先講一個關鍵事實：你的商品庫是 22,481 筆

在寫報告前我先讀了正式環境的 `/api/bootstrap`：

| 項目 | 數量 |
|---|---|
| D1 商品 | **22,481** |
| D1 標籤 | 2（舊格式 id `label_1795098969295_yupd7a`…，無 `content_hash`） |

這個數字改變了整個診斷的權重。舊版 `findBestMatch()` 對**每一個 PDF** 都會執行一次
`matchFuse.search(normalizeName(fileName))`，而 `matchFuse` 是 22,481 筆商品的 Fuse 索引。

我用真實商品名稱實測（`tools/bench-real-catalog.mjs`）：

| 舊版配對路徑 | 每檔 | 174 檔 |
|---|---|---|
| **含 Fuse（＝正式環境實際行為）** | **1,220 ms** | **212 秒（3.5 分鐘）** |
| 不含 Fuse（只算 `products.forEach` + `matchScore`） | 23 ms | 4 秒 |
| 新版（索引 + Worker） | **2.3 ms** | **0.41 秒** |

也就是說：**光是「自動配對」這一步，舊版在桌機上就要 3.5 分鐘完全佔住主執行緒，iPhone 上 10 分鐘跑不完完全合理** —— 這正是你觀察到的「逐個 PDF 上傳很慢，10 分鐘仍未完成」。而配對卡住時，UI 完全沒有辦法更新，所以進度條也不會動。

### 0.2 「停在 10 / 174」

**「停在 10 / 174」不是隨機卡頓，而是三個設計缺陷疊加的必然結果，而且「10」這個數字是程式碼裡 `processed % 10 === 0` 的批次存檔點。**

1. 舊版把 174 個 PDF 的處理寫成**一個大 `for` 迴圈 + 一條 await 鏈**，整段只有 `try { ... } finally { cloudSyncing=false }`，**沒有任何 per-file 錯誤處理**。
2. 迴圈裡第一次「批次寫入 IndexedDB」發生在 `processed % 10 === 0`，也就是**第 10 個檔案**。只要這次 `saveLabelsLocal()` 的 transaction 失敗（空間不足）或永遠不完成（iOS 背景/鎖屏的 transaction 停擺），錯誤就會衝出整個迴圈：`updateStats()`、`renderMatchList()`、雲端上傳、完成訊息**全部不會執行**，畫面就永遠停在最後一次 `showStatus()` 印出的「本機處理中：10 / 174」。
3. 讓「第一次就失敗」變得很容易的原因是：舊版標籤 id 是 `label_{Date.now()}_{random}`，**沒有內容去重**。每次重試、每次重新選擇，都在 IndexedDB 再塞 174 份 Blob；而且 Blob 直接存在 `labels` 記錄裡，App 一啟動 `getAll('labels')` 就把全部 PDF 反序列化進記憶體。於是「越試越卡、越卡越試」。

我用 Node 把 HEAD 版本的實際函式原封不動抽出來重跑，**兩種失敗模式都精準重現「10 / 174」**（見第 3 節 T1、T2）。

---

## 1. 舊版程式碼實際流程（逐行追蹤）

`index.html` 第 92 行是唯一的 PDF 匯入進入點，等價於：

```js
$('pdfInput').addEventListener('change', async e => {
  const files = [...e.target.files].filter(isPdf);
  cloudSyncing = true;
  try {
    for (const [index, file] of files.entries()) {
      showStatus('pdfStatus', `本機處理中：${index + 1} / ${files.length}`);
      await new Promise(r => setTimeout(r, 0));          // ① 讓出主執行緒
      const id = `label_${Date.now()}_${Math.random()...}`; // ② 隨機 id，無法去重
      const label = { ..., blob: file };                  // ③ Blob 存在 label 記錄內
      labels[id] = label;
      await applyAutoMatch(label, false, false);          // ④ 同步 O(商品數) 掃描
      if ((index + 1) % 10 === 0) {
        await saveLabelsLocal(newLabels.splice(0));       // ⑤ 第 10、20、30… 個檔案存檔
      }
    }
    await saveLabelsLocal(newLabels);
    await saveProducts(products);                          // ⑥ 整張商品表重寫
  } finally {
    cloudSyncing = false;                                  // 只有這一行會執行
  }
  // ⑦ 到這裡才會更新畫面 + 上傳雲端；上面拋錯就永遠到不了
  updateStats(); renderMatchList();
  await syncLabelsCloudBatch(...);
});
```

### 阻塞點 ①：`setTimeout(0)` 讓出主執行緒 —— 在 iOS 上會變成暫停

`await new Promise(r => setTimeout(r, 0))` 看起來很安全，但 iOS Safari 在頁面進入背景（鎖屏、切 App、省電）時會凍結 timer。使用者選完 174 個 PDF 後把手機放下 / 螢幕熄掉，這個 `await` 就永遠不會 resolve，迴圈停住，也不會拋錯。

### 阻塞點 ⑤：第一個 `await` 是「寫 10 個 Blob」

`saveLabelsLocal()` 開一個 `readwrite` transaction，一次 `put` 10 個含 PDF Blob 的記錄：

```js
async function saveLabelsLocal(list){
  const db = await openDB(), tx = db.transaction('labels','readwrite'), store = tx.objectStore('labels');
  list.forEach(label => store.put(label));
  return new Promise((res,rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
```

- **沒有 `onabort`**、**沒有 timeout**。iOS 在儲存壓力或背景狀態下，transaction 會停在 pending，`oncomplete` 永遠不觸發 → `await` 永久 pending，沒有錯誤可以捕捉。
- 失敗時（`QuotaExceededError`）`rej` 會讓錯誤往外拋，**整個批次直接結束**，而且因為事件監聽器是 async 函式，錯誤只會變成 unhandled promise rejection，**使用者看不到任何訊息**。

### 阻塞點 ④：`applyAutoMatch` 對每個檔案掃描全部商品

`findBestMatch()`：

```js
products.forEach(p => { ... codes.some(c => fileDigits.includes(c)) ... });  // 全部商品
matchFuse.search(normalizeName(fileName)).slice(0,20)                       // 全部商品的 Fuse 掃描
if (!candidateMap.size) products.slice(0,300)                               // 再 300 個
```

`matchScore()` 內部又對每個候選做 `normalizeName` / `compact` / `tokens` / `dice`（多個 regex + NFKC + Set 建立）。

而且 `matchFuse` 是**全部商品**的 Fuse 索引。用你的真實商品名稱（22,481 筆）實測：

| 動作 | 每檔耗時 |
|---|---|
| `matchFuse.search()`（22,481 筆 × 3 個 key、threshold 0.55） | **≈1,197 ms** |
| `products.forEach` 條碼掃描 + `matchScore` | ≈23 ms |
| **合計** | **1,220 ms** |

174 個檔案 → **212 秒**，而且**全部在主執行緒**。所以：
- 進度文字就算寫進 DOM，瀏覽器也沒有機會重繪 → 使用者看到「沒有進度」。
- 使用者一旦切走 App 或鎖屏，`setTimeout(0)` 被凍結，迴圈停擺。
- iOS 的 watchdog 也可能在長時間主執行緒阻塞後直接重載頁面。

`getLabelProduct()` 在 `renderMatchList()` 裡也是 `products.find()`，22,481 筆 × 標籤數，又一輪 O(標籤 × 商品)。

### 阻塞點 ⑥：`saveProducts(products)` 每批都整表重寫

```js
async function saveProducts(list){
  const tx = db.transaction('products','readwrite');
  s.clear(); list.forEach(p => s.put(p));       // 整張表刪掉再寫
  ...
  if (cloudEnabled && !cloudSyncing) await syncProductsCloud(list);  // replace:true → DELETE FROM products
}
```

商品多時這是一個大 transaction；而 `syncProductsCloud()` 第一批帶 `replace: i === 0`，伺服器端會執行 **`DELETE FROM products`**。在 `bulkRematchBtn`、Excel 匯入等路徑 `cloudSyncing` 是 `false`，只要當下本機商品清單是空的或只有部分（例如雲端讀取失敗、只匯入一小份 Excel），**整個 D1 商品表會被清空**。這是資料遺失等級的風險，必須修。

### 其他潛伏問題

| 位置 | 問題 | 影響 |
|---|---|---|
| `syncLabelsCloudBatch` | `Object.values(labels)[batchStart + i]` 用陣列索引對應標籤 | 只要有一個標籤被刪除或 `labels` 重新排序，就會上傳到錯的標籤（PDF 內容與 D1 記錄對不上） |
| 同上的 4 路並行 | `Promise.all(pending.slice(i,i+4))` 無重試 | 一個上傳失敗整批 `catch`，剩下的檔案不會再試 |
| `loadAllLabels()` | `labels` store 內含 Blob，`getAll()` 一次全部載入 | 174 個 PDF 各 1–3MB → iPhone 記憶體不足，Safari 直接終止分頁（看起來像「App 自動重新載入」） |
| Excel 匯入 | `for (const l of Object.values(labels)) await applyAutoMatch(l)` 且 `persist=true` | 每個標籤各自一次 IDB 寫入 + 一次雲端 PATCH（174 次往返），極慢 |
| `renderMatchList()` | 每次全文重畫，且在迴圈結束後才跑 | 174 列 DOM + 每列 `getLabelProduct()` 又 `products.find()`（O(標籤×商品)） |
| `sw.js` / `sw-v5.js` | 連 `index.html` 都 cache-first | **部署新版後，手機仍然執行舊的 index.html**；使用者會覺得「改了還是卡」，其實根本沒載到新版 |
| `content-disposition` / R2 讀取 | `object.body` 直出、無 Range | iPhone 上大 PDF 預覽較容易失敗（已加 Range 支援） |

---

## 2. 逐項回答你指定的檢查點

| 你要求檢查的項目 | 結論 |
|---|---|
| **IndexedDB transaction 是否因大量 Blob 阻塞或超 quota** | **是，主因之一。** 一次 transaction 寫 10 個含 PDF 的記錄；`oncomplete` 沒有 timeout/`onabort`。iOS 在背景會讓 transaction 停擺（不是失敗，是永遠 pending）。加上沒有去重，重試會持續累積 Blob 直到 quota 爆掉。已在 T1/T2 重現。 |
| **iOS Safari 對大量 File object 的限制** | 選 174 個檔案本身可以（檔案 App 支援多選），但每個 `File` 都是「延遲讀取」的 handle，**不要**一次讀完、不要建立 174 個 object URL。新版只讀「頭/中/尾各 128KB」算指紋，其餘完全交給瀏覽器與 R2 串流。 |
| **自動配對是否仍逐檔掃描整個商品陣列** | **是。** `products.forEach` + `Fuse.search` 全庫 + `matchScore` 逐個重算，O(PDF 數 × 商品數)。新版改成建索引 + 倒排候選。 |
| **Promise / await / `transaction.oncomplete` 死鎖** | **是，主因之一。** 沒有 timeout、沒有 `onabort`，`await` 可以永久 pending；外層沒有 per-file try/catch，第一個失敗就吞掉整批。 |
| **Service Worker 攔截或快取錯誤** | **有，嚴重但屬於「症狀放大器」。** `/api/` 有排除、非 GET 有排除，但 `index.html` 用 cache-first，導致修正後的手機仍跑舊版。已改成 shell/JS network-first（3 秒超時回快取），vendor 才 cache-first。 |
| **R2 上傳是否在本機處理階段被意外觸發** | 沒有（有 `cloudSyncing` 旗標擋住），但**這個旗標同時讓 `saveProducts()` 的雲端同步被跳過**，造成本機／雲端商品不一致；而拿到旗標之外的 `bulkRematchBtn`、Excel 路徑又會觸發 `DELETE FROM products`。已改成階段分離 + 只合併不刪除。 |
| **174 個 PDF 是否因之前失敗而重複累積在 IndexedDB** | **是。** 每次匯入都產生新的隨機 id，舊資料不會被覆蓋。新版 id = `內容 hash + 檔名 hash`，同一份 PDF 永遠是同一個 id。另外 v2→v3 遷移會把舊資料裡的 Blob **搬到獨立 store**（不刪資料）。 |
| **進度 UI 是否因主執行緒阻塞無法更新** | **是。** 配對在主執行緒跑 O(F×P)，且 `renderMatchList()` 整表重畫。新版配對在 Web Worker、每列只更新自己那一格 DOM。 |

---

## 3. 壓力測試與重現實驗結果

> 執行方式：`cd tools && npm install && node tools/stress-test.mjs`
> 資料：5,000 個商品、174 個 PDF（80KB–900KB，合計 79.7MB），檔名模擬實際情況（完全同名／加「-營養標示」／含條碼／12% 對不到商品）。

### 3.1 重現舊版卡在「10 / 174」

| 測試 | 結果 |
|---|---|
| **T1** 舊流程，第 1 次批次存檔丟出 `QuotaExceededError` | 處理到 **10 / 174** 後中止；錯誤名稱 `QuotaExceededError`；`finally` 之後的更新與上傳全部沒跑 → **畫面永久停在「本機處理中：10 / 174」** |
| **T2** 舊流程，transaction 永不完成（模擬 iOS 背景／鎖屏） | 1.2 秒後仍未結束（永久 pending），處理到 **10 / 174**；沒有錯誤、沒有逾時可以救 |

兩者都精準落在 10，因為 10 就是 `processed % 10 === 0` 的第一個存檔點。

### 3.2 舊版配對成本

**合成資料（5,000 商品、不含 Fuse）**

| 項目 | 數值 |
|---|---|
| 每個檔案 `findBestMatch` | **8 ms** |
| 推估 174 個檔案 | **1,310 ms**（純桌機 Node） |
| `matchScore` 呼叫次數 | **870,000 次**（全部在主執行緒） |

**生產規模（22,481 個真實商品名稱，`node tools/bench-real-catalog.mjs`）**

```
舊版（含 Fuse，實際生產行為）
  Fuse 索引建立        : 59.1ms
  每檔 findBestMatch   : 1220.4ms
  174 檔推算           : 212.3 秒（全部在主執行緒）

舊版（不含 Fuse，只算 products.forEach + matchScore）
  每檔                 : 23.3ms
  174 檔推算           : 4.0 秒

新版（索引 + Worker）
  索引建立（一次）     : 900.6ms（在 Worker 內，不影響 UI）
  174 檔配對           : 406.1ms（每檔 2.33ms）
  配對成功             : 154 / 174
  相對舊版（含 Fuse）  : 523× 快
```

### 3.3 新版配對（索引 + Worker）

| 項目 | 5,000 商品 | 20,000 商品 |
|---|---|---|
| 建立索引（只做一次） | 96–145 ms | 337–595 ms |
| 配對 174 個檔案 | 198–239 ms | 515–568 ms |
| 平均每檔 | **1.1–1.4 ms** | 2.9–3.3 ms |
| 最佳解與「暴力比對全部商品」不一致 | **0 筆**（174 檔全部一致，見 T4） | — |

T4 用「暴力掃描全部商品」當作正確答案的基準：174 個檔案中，**實際會採用的配對結果 0 筆不一致**；僅有 18 筆是「同樣都判定不配對，但低信心候選不同」，不影響任何實際結果。

### 3.4 新版端到端（174 個 PDF）

| 指標 | 結果 |
|---|---|
| **本機階段**（指紋 + 存檔 + 配對，174 檔 / 79.7MB） | **675–777 ms（每檔 3.9–4.5 ms）** |
| 含雲端上傳（模擬 15% 失敗 + 重試、並行 2） | 18.5 s（其中 15% 檔案各退避重試一次，其餘為網路時間） |
| 標籤數 | 174（無重複） |
| 自動配對成功 | 151 / 174 = **87%**（12% 的檔案本來就故意對不到商品） |
| Blob 寫入次數 | **174**（每檔剛好一次） |
| 上傳呼叫 / 成功 / 重複 | 198 / 174 / **0** |
| 上傳最大並行 | **2**（符合設定） |
| 狀態分佈 | `done: 174`，**0 失敗** |

### 3.5 其他行為驗證

| 測試 | 結果 |
|---|---|
| **T7 冪等性**：同一批 174 個 PDF 再選一次 | 新增標籤 **0**、Blob 重寫 **0**、上傳呼叫 **0**，全部標記 `已存在（略過）`，458 ms |
| **T8 單檔失敗隔離**：第 3 個檔案讀取失敗 | `done: 173 / failed: 1`，失敗檔案有明確原因，其餘照常完成 |
| **T9 暫停 / 繼續** | 暫停後 60ms 內處理數不變（16 → 16），繼續後 `done: 174`，已完成的沒有重做 |
| **T10 匯入前偵測到空間不足** | 自動切「雲端優先」：Blob 寫入 **0**、174 個 metadata 全留、上傳 174 成功 |
| **T10b 執行到一半才 `QuotaExceededError`** | 只失敗 1 次就切換模式，其餘 173 個照樣完成 |
| **T11 API 安全性** | `mode=merge` 不 DELETE；舊客戶端 `replace:true` **不再 DELETE**；只有 `mode=replace` + `confirm:"REPLACE_ALL"` 才 DELETE |
| **T12 R2 去重** | 同一份 PDF 再上傳 → `{deduped:true}`，R2 PUT 次數 **0** |

### 3.6 真瀏覽器流程（JSDOM 整合測試，`node tools/ui-smoke.mjs`）

```
=== UI 靜態檢查 ===
  app.js 使用的元素 id: 40 / index.html 提供的 id: 54 / 缺少的 id: (無)
=== 模擬上傳 Excel（3,000 商品）===
  statProducts: 3000 · IndexedDB 商品數: 3000
=== 模擬選取 174 個 PDF ===
  立即顯示的總數: 共 174 個 · 完成 0 · 進行中 3 · 待處理 171   ← 不用等 I/O
  job rows: 174 {"ready":174}
  pdfStatus: 本批 174 個 PDF：已完成 174 個、自動配對 149 個。
  耗時: 1255ms
=== 結果 ===
  IndexedDB 標籤數: 174 · 已配對: 146 · Blob 數: 174 (11.9MB)
  條碼尾 6 碼 311051 搜尋結果含商品: true
  matchSummary: 顯示 174 / 174 個標籤 · 已配對 146 · 待確認 0 · 未配對 28
=== 重新選取同一批 ===
  標籤數 174 / Blob 數 174（沒有增加）
=== 判定 === ✅ 全部通過
```

### 3.7 Pages Functions + D1 + R2（Miniflare 真 SQLite / R2，`node tools/api-integration.mjs`）

```
✅ 建立 products / labels 資料表
✅ 第一次寫入 1,200 個商品
✅ 舊 payload (replace:true) 不會清空商品表         ← 修掉資料遺失風險
✅ 部分更新後商品總數不變
✅ 174 個 PDF 全部寫入 D1（174 筆，34.7ms/檔）
✅ R2 有 174 個物件 / 大小與原檔一致 / content-type 正確
✅ 重複上傳回報 deduped，資料列數不變
✅ 完整下載 200 + 正確大小
✅ Range 請求回 206 且只傳 1KB（content-range: bytes 0-1023/373788）
✅ 一次請求更新 174 筆配對（1.4s）
✅ 商品 label_id 同步連結
✅ bootstrap 回傳 1,200 商品 / 174 標籤 / hash
✅ health 回報 D1/R2 狀態
✅ 刪除後 D1 與 R2 都少一筆
✅ 缺少 DB binding 時回 503 與清楚訊息
=== 17 / 17 通過 ===
```

> 註：以上數字是在 Node/JSDOM/Miniflare 環境測得。**iPhone 實機的 I/O 一定更慢**，但關鍵改善是「結構性」的：每個檔案獨立、可重試、有 timeout、不再有 O(F×P) 主執行緒掃描、不重複寫入同一份 Blob。舊版在同樣環境下光是「模擬一次失敗」就再也回不來。

---

## 4. 新架構

```
index.html                 ← 只有畫面與樣式；<script type="module" src="./js/app.js">
js/app.js                  ← 事件綁定、搜尋、預覽、分享、手動配對、Excel
js/core/text.js            ← 正規化（與舊版完全相同的行為）
js/core/matcher.js         ← 索引式配對（純函式，可測試、可跑在 Worker）
js/core/match.worker.js    ← Web Worker：模糊比對移出主執行緒
js/core/hash.js            ← 內容指紋（大小 + 頭/中/尾取樣 → SHA-256）
js/core/queue.js           ← 有限並行佇列：重試、退避、暫停/繼續
js/core/pipeline.js        ← 每個檔案的狀態機（本機階段 / 雲端階段分離）
js/store/db.js             ← IndexedDB v3：metadata 與 Blob 分開、tx timeout
js/store/api.js            ← Pages Functions 客戶端
js/ui/jobs-view.js         ← 逐列更新的進度 UI
sw-v6.js                   ← App shell / JS 用 network-first
functions/api/[[path]].js  ← API：去重、批次同步、Range、非破壞性 merge
schema.sql / migrations/   ← 只新增欄位
```

### 4.1 每個檔案的狀態機

```
pending → hashing → saving → matching → ready → uploading → done
                 ↘ duplicate（同 hash + 同檔名，完全不重做）
                 ↘ failed（單檔失敗，可重試，不影響其他檔案）
```

UI 每一列會顯示「待處理 / 計算指紋 / 本機保存 / 配對中 / 已配對 / 上傳中 / 完成 / 已存在（略過）/ 失敗」，失敗列直接顯示原因。

### 4.2 本機階段與雲端階段完全分離

- 本機階段是**單一 runner**（一次一個檔案），每個檔案的 Blob 用**自己的小 transaction** 寫入（`durability: 'relaxed'`、15 秒 timeout、有 `onabort`、自動重試）。
- 每完成一個檔案的配對，**立刻**把它丟進上傳佇列；本機階段不必等網路。
- 上傳佇列：並行 2（可調）、每次請求 180 秒逾時、失敗退避重試、`pause()/resume()`、`onIdle()`。
- 沒有任何 `Promise.all(174)`。

### 4.3 去重（解決「重複累積」）

```
contentHash = SHA-256(大小 | 前 128KB | 中 128KB | 後 128KB)
labelId     = "L" + contentHash[0..20] + "-" + fnv1a(正規化檔名)
Blob 在 IndexedDB 以 contentHash 為 key（同內容只存一份）
R2 key  = labels/{labelId}.pdf（重複上傳直接略過）
D1      = id 主鍵 upsert（不會產生第二列）
```

### 4.4 大量商品不再逐檔掃描（解決 O(F×P)）

建立索引時，每個商品只做一次 `normalize / compact / tokenize / dice 預處理`，並建立三種倒排索引：

1. **條碼尾 6 碼** → 直接命中候選
2. **字元 bigram** → 中英文檔名都能命中（「義美小泡芙」→ `義美`、`美小`、`小泡`…）
3. **空白分隔詞**

配對時只對「幾十到幾百個候選」計分（計分公式與舊版完全相同，分數、信心等級、判斷依據都一致），並在 Web Worker 執行。5,000 商品：**每檔 1.1ms**。

### 4.5 IndexedDB 空間策略（解決 quota）

1. 匯入前用 `navigator.storage.estimate()` 估算：可用空間 < 需求 × 1.35 → 直接進「雲端優先」模式。
2. 匯入中若 `putBlob` 拋 `QuotaExceededError` → 即刻切換雲端優先，**後續 173 個照樣完成**（T10b）。
3. 雲端優先模式：本機只存 metadata（商品、檔名、hash、配對結果、R2 連結），PDF 從 R2 串流預覽／分享，完全不佔本機空間。
4. App 啟動時 `getAll('labels')` 不再包含任何 Blob（v2→v3 遷移會把舊 Blob 搬到獨立 store）。

### 4.6 Service Worker

- `index.html`、`js/*` → **network-first（3 秒超時）**，離線才用快取 → 部署後不會再「跑了舊版」。
- `vendor/*` → cache-first（很少變動）。
- `/api/*`、非 GET、含 `Range` 的請求 → 完全不攔截。
- `activate` 清掉所有舊 cache（`sw.js`、`sw-v4`、`sw-v5` 的 cache 都會被刪除）。

---

## 5. 保留的既有功能（都有測試或程式碼對照）

| 功能 | 狀態 |
|---|---|
| 條碼尾 6 碼搜尋 | ✅ `doSearch()` + `barcodeTail6` 完全保留（JSDOM 測試驗證） |
| 掃碼（html5-qrcode） | ✅ 保留，掃到後自動帶入尾 6 碼 |
| 手動配對 / 解除配對 / 人工鎖定 | ✅ 保留；人工配對不會被自動配對覆蓋，批次重新配對會跳過 |
| 配對管理（篩選、排序、勾選、批次操作） | ✅ 保留，改成分頁渲染（每次 60 列，可載入更多） |
| PDF.js 本地離線預覽 | ✅ 保留（`vendor/`，無 CDN），並加上 Range 下載 |
| Web Share API 分享到 WePrint | ✅ 保留，含不支援時的「下載後手動分享」備援 |
| D1 / R2 雲端共用 | ✅ 保留（binding 名稱 `DB`、`LABELS` 不變） |
| IndexedDB 離線快取 | ✅ 保留（metadata + Blob，容量不足時自動改雲端優先） |
| 上傳 Excel 後自動重新配對 | ✅ 保留，改成 Worker 分批執行 + 進度顯示 |

---

## 6. 檔案清單

### 新增

| 檔案 | 用途 |
|---|---|
| `js/app.js` | 主程式（原本 index.html 內的所有 JS） |
| `js/core/text.js` | 正規化與相似度（與舊版行為相同） |
| `js/core/matcher.js` | 索引式配對 + 暴力比對（測試用） |
| `js/core/match.worker.js` | 配對 Worker |
| `js/core/hash.js` | 內容指紋 / 穩定 label id |
| `js/core/queue.js` | 有限並行佇列（重試、暫停、繼續） |
| `js/core/pipeline.js` | 匯入狀態機 |
| `js/store/db.js` | IndexedDB v3（含 v2→v3 Blob 遷移） |
| `js/store/api.js` | API 客戶端 |
| `js/ui/jobs-view.js` | 進度 UI |
| `sw-v6.js` | 新版 Service Worker |
| `migrations/0002_labels_hash.sql` | 既有 D1 的欄位升級（只新增） |
| `tools/*` | 測試工具（fixtures / stress-test / ui-smoke / api-integration） |

### 修改

| 檔案 | 變更 |
|---|---|
| `index.html` | 只剩版面；PDF 卡片加上「選擇資料夾」、匯入進度卡片（狀態／進度條／暫停／繼續／重試失敗／清除完成）、儲存空間顯示；改用 `<script type="module">` |
| `functions/api/[[path]].js` | 商品批次改為 merge（DELETE 需 `confirm:"REPLACE_ALL"`）；上傳去重（`content_hash`/`size`）；新增 `POST /api/labels/sync`、`GET /api/health`；PDF 支援 Range；`ensureSchema()` 自動補欄位；R2 `put` 改傳 File（避免無長度串流被拒） |
| `schema.sql` | `labels` 加上 `content_hash`、`size` 與索引 |
| `README.md` | 更新架構、測試、部署說明 |

### 未變更（刻意保留）

- `_routes.json`（仍只把 `/api/*` 交給 Functions）
- `wrangler.toml`（binding 名稱 `DB` / `LABELS`、資料庫與 bucket 名稱完全不變）
- `vendor/*`（PDF.js、SheetJS、html5-qrcode 仍在本地；`fuse.min.js` 保留但不再使用）
- `sw.js`、`sw-v4.js`、`sw-v5.js`（保留檔案避免舊註冊 404；新版註冊的是 `sw-v6.js`）

---

## 7. 部署步驟（Cloudflare Pages）

> 前提：`DB` / `LABELS` binding 與 bucket 都不變，**不會重建或清空任何資料**。
>
> ⚠️ 新版把 JS 拆成 `js/` 下的 ES modules，`index.html` 仍是唯一入口，但**不能再用 file:// 雙擊開啟**（瀏覽器會擋模組載入）。
> Cloudflare Pages、GitHub Pages、`python3 -m http.server` 都正常。若你原本的習慣是「把 index.html 丟到某個地方就能跑」，請改成連同 `js/` 目錄一起部署。

### 步驟 1：推送程式碼

```bash
cd product-label-app
git add -A
git commit -m "Refactor PDF import: per-file state machine, worker matching, dedupe, resume"
git push origin main
```

Cloudflare Pages 會自動重新部署（Build command 留空、Output directory = `/`）。

### 步驟 2：D1 欄位升級（二選一）

**A. 讓 API 自動補（最省事）**：部署後第一次呼叫 `/api/bootstrap` 或上傳時，`ensureSchema()` 會用 `PRAGMA table_info` 檢查並 `ALTER TABLE ADD COLUMN`。只新增欄位，不動任何資料。

**B. 手動執行（建議，可在部署前先做）**

```bash
npx wrangler d1 execute product-label-app --remote --file=./migrations/0002_labels_hash.sql
```

若欄位已存在會回報 `duplicate column name`，可以忽略。

### 步驟 3：驗證（含「資料沒有被刪」的對照）

**部署前的基準（2026-11-19 讀取正式環境）：**

| 項目 | 數量 |
|---|---|
| D1 `products` | **22,481** |
| D1 `labels` | **2** |

**部署後請確認這兩個數字沒有變少：**

```bash
curl -s https://product-label-app.pages.dev/api/bootstrap \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('products',j.products.length,'labels',j.labels.length)})"
# 期望：products 22481（或更多）、labels ≥ 2
```

如果數字變少，請立即 `git revert` 並回報 —— 但在新版程式碼裡，唯一的 `DELETE FROM products` 需要 `{"mode":"replace","confirm":"REPLACE_ALL"}`，前端不會送出這個組合（T11 已驗證）。

### 步驟 4：驗證

```bash
# 1) API 與資料筆數
curl https://product-label-app.pages.dev/api/health
# {"ok":true,"d1":true,"r2":true,"products":...,"labels":...}

# 2) 前端是新版（應該看得到「匯入進度」卡片）
curl -s https://product-label-app.pages.dev/ | grep -c "jobList"     # 應為 1

# 3) JS 模組可取得
curl -s -o /dev/null -w "%{http_code}\n" https://product-label-app.pages.dev/js/app.js   # 200
```

### 步驟 5：手機端確認

1. 用 Safari 開啟網址（會自動註冊 `sw-v6.js`，舊 cache 會被清掉）。
2. 「上傳」頁應看到新的 **📥 匯入進度** 卡片。
3. 一次選 174 個 PDF → 立刻看到「共 174 個 · 待處理 174」。
4. 過程中可暫停／繼續；完成後失敗的檔案會列出原因，按「↻ 重試失敗」只重跑失敗的。

> 若手機仍然看到舊畫面：請確認 `curl` 取到的 HTML 含 `jobList`（伺服器端已是新版）。若是舊版，代表 Pages 還沒部署完成；若伺服器端是新版但你看到舊畫面，表示該分頁還被舊 Service Worker 控制 —— 這是舊 SW 的 cache-first 行為造成的，新版 SW 一旦接管就不會再發生（可在 Safari 設定中查看「網站資料」確認 cache 已更新）。

### 步驟 6：回滾

```bash
git revert <commit>   # 或 git reset --hard <上一個 commit> && git push -f
```

資料層無需回滾：`content_hash` / `size` 是額外欄位，舊版程式碼會忽略它們。

---

## 8. 開發與測試

```bash
cd tools
npm install                # fake-indexeddb、jsdom、miniflare
node stress-test.mjs       # 舊版重現 + 新版壓測（T1–T12）
node ui-smoke.mjs          # JSDOM：真實 DOM 綁定 + 174 檔匯入 + 搜尋
node api-integration.mjs   # Miniflare：真 SQLite + R2，23 項 API 檢查（含 meta/ETag/revision）
node bench-real-catalog.mjs            # 用線上真實商品目錄量測新舊配對成本（可加 products.json 參數）
```

本機跑整個網站（含 Functions）：

```bash
npx wrangler pages dev . --d1 DB=product-label-app --r2 LABELS
```

---

## 9. 已知限制與建議的下一步

1. **iOS 前景限制**：本機階段已把每個檔案縮到 4ms 級別，但 174 × 1.5MB 的寫入仍受裝置 I/O 限制。若使用者常在鎖屏狀態下匯入，建議用「雲端優先」模式（設定裡可手動選擇），讓 PDF 直接進 R2。
2. **伺服器端配對**（可選）：目前配對在 Worker 完成後用 `POST /api/labels/sync` 上傳結果。若要完全免除手機 CPU 負擔，可把 `matcher.js` 直接搬到 Pages Function 執行「上傳後自動配對」；架構上已預留（`labels/sync` 就是同一個資料介面）。
3. **商品載入**：bootstrap 仍是一次回傳全部商品（22,481 筆約 2–3MB JSON），但**只在 revision 變動時才發生**：平常開頁只讀 2 列 meta。商品數再翻倍時建議改成 `/api/products?since=` 增量同步（介面已預留 revision）。
   另外索引建立（22k 商品約 0.9 秒）在 Worker 內完成；只有 Worker 不可用時才會退回主執行緒（且延後到第一次真正需要配對時才建立，不會卡在啟動階段）。
4. **PDF 指紋取樣**：目前用「大小 + 頭/中/尾各 128KB」，對同一份 PDF 重新掃描、重新命名後的去重仍有效；若需要「跨檔名」去重，可改成完整檔案 SHA-256（成本較高）。

---

## 10. 部署記錄

| 項目 | 內容 |
|---|---|
| 部署時間 | 2026-11-19（UTC+8 下午） |
| 推送 commit | `5890bac`、`89c5d26`、`d7026c2`（`9e0352f → main`，fast-forward） |
| 部署方式 | GitHub push → Cloudflare Pages 自動建置 |
| 驗證結果 | `node tools/deploy.mjs verify` **全綠** |

驗證項目（正式站 `https://product-label-app.pages.dev`）：

```
✅ index.html 是新版（含匯入進度 UI）
✅ 已註冊 sw-v6.js
✅ /js/app.js 47,260 字元 · /js/core/pipeline.js 21,059 字元
✅ /js/core/match.worker.js · /js/core/matcher.js · /sw-v6.js 內容正確
✅ vendor：pdf.min.mjs / pdf.worker.min.mjs / xlsx.full.min.js / html5-qrcode.min.js 全部 200
✅ /api/health：products 22481 / labels 2 / r2 true
✅ 商品數 22481 → 22481（+0）
✅ 標籤數 2 → 2（+0）
✅ Range 請求回 206（bytes 0-1023/67981）
```

正式環境端到端自我測試（建立 → 重複上傳 → 批次配對同步 → 下載 → Range → 刪除）：

```
起始            labels 2
上傳            ok, deduped=false
重複上傳        ok, deduped=true      ← R2 未重寫、D1 未新增列
批次配對同步    ok, count=1
下載            200, 2048 bytes
Range           206, bytes 0-99/2048
建立後          labels 3
刪除後          labels 2              ← 測試資料完全清除
D1 欄位         content_hash / size 已自動補上（bootstrap 回傳 hash 欄位）
```

> 部署未動到任何既有資料：商品 22,481 筆、既有 2 筆舊格式標籤都保持原樣。

---

## 11. 事故與修正：D1 免費額度用盡（2026-11-19）

### 症狀

1. 手機開啟網站，紅色橫幅顯示「雲端 API 尚未啟用」——但 Cloudflare 設定完全正常。
2. 之後 `/api/health` 回 `D1_ERROR: Your account has exceeded D1's free tier daily row read limit`，
   `/api/bootstrap` 回 `error code: 1101`。

### 兩個真正的原因

**原因 A（誤判，前端）：** `loadCloudData()` 把「雲端 bootstrap」與「寫入本機 IndexedDB 快取」
包在同一個 `try` 裡。iOS 上單一交易寫 22,481 筆會超過 60 秒逾時 → 例外 → `catch` 把
`state.cloudEnabled` 設成 `false`，於是畫面顯示「雲端 API 尚未啟用」，而且按「同步」會直接中止。
資料其實完全沒問題，是錯誤訊息騙了操作者。

**原因 B（真的把額度燒完，後端）：** 免費方案每天 5,000,000 列讀取。

| 動作 | 舊版讀取列數 | 新版讀取列數 |
|---|---|---|
| `/api/health`（每 8 秒被 deploy verify 輪詢） | 約 45,000（兩次 `COUNT(*)` 掃 22,481 列） | **2** |
| 每次開啟頁面 `/api/bootstrap` | 22,481 | 0（revision 相同時不呼叫） |
| 每次開啟頁面的版本檢查 | — | **2**（`/api/meta`） |
| 標籤清單 | 22,481 + 標籤 | 只有標籤（數十列） |
| 同 revision 再次 bootstrap | 22,481 | 0（邊緣快取／ETag 304） |

以 5,000,000 ÷ 22,481 ≈ **220 次全量 bootstrap／天**，再加上 verify 每 8 秒的 `COUNT(*)`，
額度在半天內就會用完。用完之後**任何**讀取都會失敗，所以 App 看起來像「雲端沒設定」。

### 修正

1. **後端** `functions/api/[[path]].js`
   - 新增 `meta` 表（`products_revision` / `labels_revision`），寫入商品或標籤時 `bumpRevision()`。
   - `/api/health` 只讀 2 列 meta，**全檔已無 `COUNT(*)`**。
   - 新增 `/api/meta`（2 列）、`/api/labels`（只有標籤）。
   - `bootstrap` 用 `revision` 當 ETag 與 `caches.default` 邊緣快取 key，支援 `If-None-Match → 304`
     （304 不會讀商品表）。
2. **前端** `js/app.js`
   - 開頁先打 `/api/meta`；revision 與本機記錄相同 → **直接用本機快取**（只補抓標籤），完全不碰商品表。
   - revision 不同才 `bootstrap`，並把新 revision 寫進 IndexedDB（`cloudRevision`）。
   - 本機快取寫入改成獨立 `try`：失敗只顯示「本機快取寫入失敗（不影響雲端）」，
     絕不再把 `cloudEnabled` 設回 `false`。
   - 商品快照分塊寫入（`saveProductsChunked`），並用簽章比對避免每次重寫 22,481 筆。
3. **錯誤訊息** `js/store/api.js`：D1 錯誤會翻成
   「雲端資料庫暫時不可用（D1 免費額度每日 UTC 午夜重置，或可升級方案）」，
   不再讓人誤會是「沒啟用」。
4. **部署驗證** `tools/deploy.mjs`：等待上線只輪詢靜態 `index.html`（**0 次 D1 讀取**），
   驗證階段只查一次資料筆數。
5. **資料庫**：`schema.sql` 與 `migrations/0003_meta_revision.sql` 只新增 `meta` 表，
   **不動 products / labels 既有資料**（`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`）。

### 測試（全部通過）

```
tools/cloud-smoke.mjs       7 個情境、20 項斷言  ✅（含「重開頁不重抓 22,481 列」、「revision 變動才重抓」）
tools/api-integration.mjs   23 / 23             ✅（含 /api/meta 不含商品、ETag 304、revision 遞增）
tools/ui-smoke.mjs                              ✅（174 檔、搜尋、配對管理）
tools/stress-test.mjs       T1–T12              ✅（含 174 檔端到端、暫停/繼續、去重）
```

### 給使用者的結論

- 這次「雲端沒啟用」是**前端錯誤處理**造成的誤報，不是 Cloudflare 設定問題；已修正。
- 帳號的 **D1 免費每日列讀取額度**在事發當天已用完，UTC 午夜（香港時間早上 8 點）自動重置。
  重置前雲端資料讀不到，App 會用本機快取運作。
- 修正後一次正常開頁只需 **約 2–4 列讀取**（原本 22,481 列），
  等同每天可開頁數從約 220 次提升到數十萬次級別。
- 若仍想完全避免免費額度風險：Cloudflare 方案升級到 Workers Paid（D1 讀取額度大幅提高）。

### 實際部署與上線驗證（2026-11-19 20:07 UTC）

| 項目 | 結果 |
|---|---|
| 推送 | `main` = `3a2dac2`（`71367bf → ae01274 → 17b5c6c → 3a2dac2`） |
| 靜態檔 | 線上 `index.html`、`js/app.js`(56,539B)、`js/store/api.js`(4,563B)、`js/core/pipeline.js`、`js/core/matcher.js`、`sw-v6.js` 與本地 **SHA-256 完全一致** |
| Functions | `/api/meta`、`/api/labels` 路由已存在（部署前是 404） |
| `/api/meta` 回應 | `{"cloud":true,"degraded":true,"schemaError":"D1_ERROR: no such table: meta"}` |
| `/api/health` 回應 | `{"ok":false,...,"metaTable":false,"schemaError":"D1_ERROR: ... exceeded ... free tier daily row read limit"}` |

**為什麼 meta 表還沒建起來**：`CREATE TABLE IF NOT EXISTS meta` 本身需要讀 schema，而當天的列讀取額度已經用完，
所以 DDL 也被擋下（`ensureSchema` 會記下 `schemaError` 並在每次請求時重試）。
**額度在 UTC 午夜（香港 08:00）重置後，第一個 API 請求就會自動建立 `meta` 表，不需要手動跑 SQL。**

在此期間的預期行為（已用 `deploy check` / curl 驗證）：

- `deploy check` → `✅ Functions 是新版（/api/meta 路由存在）` + `⚠️ API 可連線，但 D1 今天讀不到資料`
- 手機開啟 App → 顯示 `無法連線雲端：D1_ERROR: ... exceeded ... ｜雲端資料庫暫時不可用（D1 免費額度每日 UTC 午夜重置，或可升級方案）`，
  **不再是誤導的「雲端 API 尚未啟用」**；本機 IndexedDB 資料仍可瀏覽、搜尋、看 PDF。
- 額度重置後 → 第一次開頁做一次全量 bootstrap 並建立 `meta` 表，之後開頁只需約 2 列讀取。

---

## 12. 額度重置後的正式站複驗（2026-11-20 05:56 UTC / 13:56 HKT）

`meta` 表在額度重置後**由 API 自動建立**（`degraded:false`），不需要手動跑 SQL。

### `tools/live-verify.mjs`：20 / 20 通過

```
=== 1. 便宜的版本檢查 ===
✅ /api/meta 200、degraded:false、不含商品陣列
✅ x-d1-rows-read: 2

=== 2. bootstrap ===
✅ 200，2,279ms，3,299KB
✅ 商品 22,481（資料一筆沒少）
✅ 標籤 176（174 筆有新 hash，2 筆舊格式）
✅ 每個標籤都有 hash 欄位
✅ ETag W/"bootstrap-3.5" + x-data-revision
✅ 帶 If-None-Match 回 304（0 次商品表讀取）

=== 3. /api/labels ===
✅ 只回 176 個標籤（71.3KB），完全不含 22,481 筆商品

=== 4. Range ===
✅ 206 bytes 0-1023/67981

=== 5. 端到端 ===
✅ 上傳（deduped:false）→ 重複上傳（deduped:true，R2 沒重寫）
✅ labels_revision 由 1 → 3（寫入會遞增，前端才知道要更新）
✅ 批次配對同步 count:1
✅ 下載內容一致（191 bytes）· Range 206 bytes 0-99/191
✅ 刪除暫存標籤，標籤數回到 176（測試資料完全清除），revision 3 → 5
```

`node tools/deploy.mjs verify`：**驗證通過**（前端 7 項、vendor 4 項、health、商品 22,481 / 標籤 176、Range 206）。

### 讀取成本對照（正式站實測）

| 情境 | D1 讀取列數 | 備註 |
|---|---|---|
| 一般開頁（revision 沒變） | `/api/meta` **2 列** + `/api/labels` 176 列 = **178** | 原本 22,481 |
| 開頁且 revision 變了 | 22,481（一次）+ 之後走上面那條 | 有 `cache-control: max-age=60` 與 ETag |
| 再次請求 bootstrap 且 revision 未變 | **0**（304） | 已實測 `status=304` |
| `/api/health` | **2 列** | 原本約 45,000 |

以 500 萬列/日計算：修正前約 **220 次開頁**就會用完；修正後一般開頁約 178 列，
可支撐**約 28,000 次開頁／日**，等於同一個免費額度下安全邊界提高約 126 倍。

---

## 13. 新增：標籤編輯與重複標籤清理（2026-11-21）

需求：使用者反映「有些標籤、有些資料是錯的」，主要是**同一份 PDF 出現多筆重複**，
希望可以自己修改／刪除標籤。

### 新增功能

| 功能 | 位置 | 說明 |
|---|---|---|
| 🔁 重複篩選 | 配對管理 → 篩選列 | 以 PDF 內容指紋（`hash`）判定；舊資料沒有 hash 時退回用名稱比對。按鈕上直接顯示「多出幾筆」 |
| 重複提示橫幅 | 配對管理上方 | 顯示「發現 N 組重複，共 M 筆多餘」，兩個一鍵按鈕 |
| 保留這筆，刪除其他 N 筆 | 每筆重複標籤上 | 由使用者自己決定留哪一筆，其他同內容的刪掉 |
| 每組只留一筆 | 橫幅按鈕 | 自動選擇保留：人工配對 → 已配對 → 最新上傳 |
| 勾選多餘的 | 橫幅按鈕 | 把每組多餘的自動勾選起來，可再人工確認後批次刪除 |
| ✏️ 編輯標籤 | 每筆標籤 → 編輯 | 改「顯示名稱」；同一個視窗可直接「改成其他商品」或「刪除此標籤」 |
| 🗑 刪除所選標籤 | 批次動作列 | 勾選後一次刪除，雲端 PDF 一起刪 |
| 重複標記 | 每筆標籤上 | `重複 ×3` 標籤，一眼看出同組有幾筆 |

### 刪除時會做的事（三個地方一起清）

1. **雲端 D1**：刪除 `labels` 那一列、把 `products.label_id` 清空
2. **雲端 R2**：刪除 `labels/<id>.pdf`；批次刪除用 `POST /api/labels/bulk-delete`（一次請求，最多 300 筆）
3. **本機 IndexedDB**：刪除標籤記錄；Blob **只有在沒有其他標籤共用同一個 hash 時**才刪除（避免把還在用的檔案刪掉）

刪除與改名都會遞增 `labels_revision` / `products_revision`，其他裝置下次開頁就會更新。

### API 變更

- `PATCH /api/labels/:id` 改為**部分更新**：只改 body 有帶的欄位。
  這修掉一個潛在資料問題：舊版一律覆寫，若前端只送 `nameFromFile` 會把配對資料洗掉。
  新增支援 `nameFromFile`（標籤顯示名稱，上限 300 字元）。
- 新增 `POST /api/labels/bulk-delete`，body `{ "ids": [...] }`（上限 300 筆）。
  會先刪 R2 物件，再用 `DB.batch()` 一次清 D1，最後遞增版本號。

### 測試

`tools/label-edit-smoke.mjs`（JSDOM + fake-indexeddb，**33 / 33 通過**）：

```
1. 重複偵測      3 筆同 hash 的群組與 2 筆群組都正確辨識，多餘 3 筆、篩選數字 3、列表有「重複 ×3」
2. 保留這筆       指定保留人工配對那筆 → 其他 2 筆消失；共用 Blob 沒有被誤刪
3. 每組只留一筆   自動保留「人工配對 → 最新上傳」那筆，重複數字歸零、橫幅消失
4. 修改名稱       IndexedDB 與畫面都更新，配對資料沒有被洗掉
5. 刪除單筆       IndexedDB 記錄與 Blob 都刪除，統計同步
6. 批次刪除       勾選 2 筆一次刪除，選取清單清空，本機只剩 2 個 Blob
```

回歸測試：`ui-smoke`（174 檔、搜尋、配對管理）✅、`cloud-smoke`（雲端同步 7 情境）✅、
`api-integration` **32 / 32** ✅（新增改名與批次刪除 9 項）、`stress-test` T1–T12 ✅。

`sw-v6.js` 版本由 `v9` → `v10`，確保手機拿到新的 `app.js`（舊快取不會卡住）。

---

## 14. 新增：支援 PDF 以外的檔案（.wdfx 等 WePrint 可讀格式）

背景：使用者把 PDF 轉成 `.wdfx`（WePrint App 讀得到），但原本的選擇器
`accept="application/pdf,.pdf"` 會讓這些檔案在 iPhone 上變成灰色不能選；
即使選進來，`intake()` 也會用 `/\\.pdf$/` 把它們全部過濾掉。

### 改法：改用「檔頭位元組」判斷格式，不再看副檔名

新增 `js/core/filetype.js`：

| 檔頭 | 判定 | 站內行為 |
|---|---|---|
| `%PDF-` | `kind: 'pdf'` | PDF.js 預覽（**改名成 .wdfx 的 PDF 也能預覽**）|
| JPEG / PNG / GIF / WebP / HEIC / BMP / TIFF | `kind: 'image'` | 直接顯示圖片 |
| `PK\x03\x04` / OLE / PostScript 等 | `kind: 'file'` | 保存、上傳、分享；不預覽 |
| 其他（例如真正的二進位 .wdfx） | `kind: 'file'`，保留原 mime 與副檔名 | 保存、上傳、分享；不預覽 |

### 具體變更

1. **`index.html`**：`選擇多個 PDF` → `選擇多個檔案`，移除 `accept` 限制（iOS 才能選到 `.wdfx`）。
2. **`js/core/pipeline.js`**
   - `intake()` 改為 async：先讀每個檔案的檔頭再建立 job（174 個檔案約 30ms）。
   - 不再用副檔名過濾；job / label 增加 `kind`、`mime`、`ext`。
   - `nameFromFile` 改成去掉**任何**副檔名（原本只去 `.pdf`）。
3. **`js/app.js`**
   - 預覽分三路：PDF → PDF.js、圖片 → `<img>`、其他 → 「此格式無法在網站內預覽，請直接分享到 WePrint 或下載」。
   - 分享／下載保留**原始檔名與 Content-Type**（WePrint 靠這兩者判斷格式）。
   - 標籤列表顯示格式徽章（例如 `WDFX（不支援預覽）`、`PNG（可預覽）`）。
4. **`functions/api/[[path]].js`**
   - R2 物件 key 由 `labels/<id>.pdf` 改為 `labels/<id>.<ext>`，並存 `mime` 欄位（`ensureSchema` 會自動 `ALTER TABLE`）。
   - 上傳改用真正的 Content-Type；下載回應帶回儲存的 mime，`?download=1` 時用 `attachment`。
5. **`schema.sql` / `migrations/0004_label_mime.sql`**：新增 `mime TEXT DEFAULT 'application/pdf'`（純新增欄位）。

### 測試

`tools/filetype-smoke.mjs`（**24 / 24 通過**）：

```
1. 檔頭判斷：PDF 改名 .wdfx → pdf；PNG/JPEG → image；DOCX → file；未知二進位 → file（保留 .wdfx）
2. 匯入流程：3 個檔案（.wdfx 的 PDF、PNG、真 .wdfx）全部收下，kind 正確，Blob 都寫入本機
3. 站內預覽：圖片顯示 <img>；未知格式顯示「無法在網站內預覽」並提示可用 WePrint
4. 上傳／分享：表單帶 mime=application/octet-stream、ext=wdfx、原始檔名；
   分享出去的檔案名稱仍是 洗髮精 400ml.wdfx、type=application/pdf
```

回歸：`api-integration` 32/32 ✅、`ui-smoke` ✅（174 PDF）、`label-edit-smoke` 38/38 ✅、`stress-test` T1–T12 ✅。

### 上線與驗證（2026-11-24 15:03 UTC）

`main` = `45f8e07`（Cloudflare Pages 已建置）。正式站實測 **14 + 20 項全部通過**：

```
✅ index.html：id="pdfInput" multiple（已移除 accept，iOS 可選 .wdfx）
✅ /js/core/filetype.js 已上線；/js/app.js 含「無法在網站內預覽」
✅ /api/health ok、meta 表存在（products_revision 5 / labels_revision 7）
✅ 既有 176 筆標籤的 mime 欄位自動補上預設值（176/176）
✅ 上傳 .wdfx（副檔名 wdfx、mime octet-stream）：檔案名、mime、顯示名稱都正確
✅ 下載 Content-Type: application/octet-stream（不再硬寫 application/pdf）
✅ Content-Disposition 保留 洗髮精 400ml.wdfx（inline 與 ?download=1 的 attachment）
✅ Range 206（bytes 0-9/69）對非 PDF 副檔名同樣正常
✅ bootstrap 商品 22,481 筆不變、ETag 304、標籤 176 筆
✅ 測試用暫存標籤已刪除，標籤數回到 176
```
