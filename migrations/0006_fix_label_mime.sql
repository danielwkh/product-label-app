-- 0006_fix_label_mime.sql
-- 早期 .wdfx / 其他非 PDF 標籤的 mime 被存成 application/pdf，
-- 導致手機下載變成 PDF、或 WePrint（微打）拒絕開啟。
-- 這裡只修正 mime 欄位，不會動任何檔案或配對資料。
UPDATE labels SET mime = 'application/octet-stream'
 WHERE filename IS NOT NULL AND lower(filename) NOT LIKE '%.pdf';
UPDATE labels SET mime = 'application/pdf'
 WHERE filename IS NOT NULL AND lower(filename) LIKE '%.pdf';
