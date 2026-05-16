const NO_STORE_EXTENSIONS = new Set(['.html', '.js', '.css']);

export function setStaticCacheHeaders(res, filePath) {
  const lower = String(filePath || '').toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  const ext = dotIndex >= 0 ? lower.slice(dotIndex) : '';
  if (!NO_STORE_EXTENSIONS.has(ext)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}
