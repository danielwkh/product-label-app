/*
 * 檔案格式辨識
 *
 * 目的：不要用「副檔名」決定要不要收這個檔案。
 * 使用者可能把 PDF 改名成 .wdfx / .pdfx，或直接用其他 App 匯出的檔名。
 * 這裡改看檔頭位元組（magic bytes），因此：
 *   - 真正的 PDF（即使檔名是 .wdfx）→ 走 PDF 流程，可以預覽
 *   - 圖片 → 直接顯示預覽
 *   - 其他格式（WePrint 這類 App 能讀、我們不需要解析的）→ 一樣保存、上傳、分享，
 *     只是不在網站內預覽
 */

export function extFromName(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

export function stripExtension(name) {
  return String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

function ascii(bytes, start, length) {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * @returns {Promise<{kind:'pdf'|'image'|'file', mime:string, ext:string}>}
 */
export async function sniffFile(file) {
  const ext = extFromName(file && file.name) || 'bin';
  let head = new Uint8Array(0);
  try {
    head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  } catch {
    /* 讀不到檔頭（例如已經被釋放）就用副檔名與 type 判斷 */
  }

  // PDF：檔頭是 %PDF-（允許前面有 BOM 或空白）
  const first16 = ascii(head, 0, 16).replace(/^\uFEFF/, '').trimStart();
  if (first16.startsWith('%PDF')) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };

  // 圖片
  if (head[0] === 0xff && head[1] === 0xd8) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (ascii(head, 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (ascii(head, 4, 4) === 'ftyp' && /^(heic|heix|mif1|msf1)$/i.test(ascii(head, 8, 4))) {
    return { kind: 'image', mime: 'image/heic', ext: 'heic' };
  }

  // 常見但不是我們能預覽的格式：照樣支援保存／上傳／分享
  if (ascii(head, 0, 4) === 'PK\u0003\u0004') {
    const mime = ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : 'application/zip';
    return { kind: 'file', mime, ext };
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return { kind: 'file', mime: 'application/x-ole-storage', ext };
  }
  if (ascii(head, 0, 4) === '%!PS') return { kind: 'file', mime: 'application/postscript', ext: ext === 'bin' ? 'ps' : ext };
  if (ascii(head, 0, 2) === 'BM') return { kind: 'image', mime: 'image/bmp', ext: 'bmp' };
  if (ascii(head, 0, 3) === 'II*' || ascii(head, 0, 3) === 'MM\u0000') return { kind: 'image', mime: 'image/tiff', ext: 'tiff' };

  // 判斷不出來：保留原檔（WePrint 之類的 App 可能讀得到）
  return { kind: 'file', mime: (file && file.type) || 'application/octet-stream', ext };
}

export function labelKind(label) {
  if (!label) return 'pdf';
  if (label.kind) return label.kind;
  // 舊資料沒有 kind：以副檔名推測，避免既有 PDF 標籤行為改變
  const ext = extFromName(label.filename);
  if (!ext || ext === 'pdf') return 'pdf';
  return 'file';
}
