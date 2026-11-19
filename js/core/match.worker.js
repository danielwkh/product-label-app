/*
 * 配對 Web Worker：把模糊比對移出主執行緒，避免 iPhone Safari 長時間凍結 UI。
 */
import { buildIndex, matchFileName, searchProducts } from './matcher.js';

let index = buildIndex([]);

function toResult(best) {
  if (!best) return null;
  return {
    productId: best.product.id,
    productName: best.product.name,
    score: Math.round(best.score),
    rawScore: best.score,
    why: best.why,
    barcodeHit: best.barcodeHit,
    coverage: best.coverage,
    gap: Math.round(best.gap),
    confidence: best.confidence,
    secondBestId: best.secondBest ? best.secondBest.product.id : null,
    secondBestName: best.secondBest ? best.secondBest.product.name : null
  };
}

self.addEventListener('message', event => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init' || msg.type === 'set-products') {
      index = buildIndex(msg.products || []);
      self.postMessage({ type: 'indexed', count: index.size, reqId: msg.reqId || null });
      return;
    }
    if (msg.type === 'match') {
      const manualLabelIds = new Set(msg.manualLabelIds || []);
      const results = (msg.items || []).map(item => {
        const best = matchFileName(index, item.name, {
          manualLabelIds,
          currentLabelId: item.labelId || null,
          maxCandidates: msg.maxCandidates
        });
        return { key: item.key, result: toResult(best) };
      });
      self.postMessage({ type: 'matched', reqId: msg.reqId || null, results });
      return;
    }
    if (msg.type === 'search') {
      const items = searchProducts(index, msg.query, msg.limit || 10).map(item => ({
        id: item.id,
        name: item.name,
        barcode: item.barcode,
        barcode2: item.barcode2,
        labelId: item.labelId
      }));
      self.postMessage({ type: 'searched', reqId: msg.reqId || null, items });
      return;
    }
    self.postMessage({ type: 'error', reqId: msg.reqId || null, error: 'unknown message type' });
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId || null, error: String(err && err.message || err) });
  }
});
