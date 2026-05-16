const PARAM_META = [
  ['size', '请求尺寸'],
  ['quality', '质量'],
  ['format', '格式'],
  ['count', '张数'],
];

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)} 毫秒`;
  if (n < 60000) return `${(Math.round(n / 100) / 10).toFixed(1)} 秒`;
  const minutes = Math.floor(n / 60000);
  const seconds = Math.round((n % 60000) / 1000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function formatResolution(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
  return `${Math.round(width)}x${Math.round(height)}`;
}

function normalizeParams(record) {
  const requested = record.requestedParams || {};
  const actual = record.actualParams || {};

  return PARAM_META.reduce((items, [key, label]) => {
    const actualValue = actual[key] ?? null;
    const requestedValue = requested[key] ?? null;
    if (actualValue == null && requestedValue == null) return items;
    items.push({
      key,
      label,
      actual: actualValue == null ? null : String(actualValue),
      requested: requestedValue == null ? null : String(requestedValue),
    });
    return items;
  }, []);
}

export function buildDetailViewModel(record, imageIndex = 0) {
  const images = Array.isArray(record.images) ? record.images : [];
  const maxIndex = images.length > 0 ? images.length - 1 : 0;
  const safeIndex = Math.max(0, Math.min(maxIndex, imageIndex));
  const revisedPrompt = typeof record.revisedPrompt === 'string' ? record.revisedPrompt.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  const activeImage = images[safeIndex] || null;

  return {
    recordId: record.id,
    prompt,
    revisedPrompt,
    showRevisedPrompt: Boolean(revisedPrompt && revisedPrompt !== prompt),
    displayParams: normalizeParams(record),
    images,
    activeImage,
    imageIndex: safeIndex,
    imageCount: images.length,
    resolution: formatResolution(activeImage),
    duration: formatDuration(record.durationMs),
    status: record.status || '',
    createdAt: record.ts || null,
  };
}

export function createDetailRecordPayload({ prompt, size, quality, format, count, durationMs, result }) {
  return {
    prompt,
    requestedParams: { size, quality, format, count },
    actualParams: result?.actualParams || null,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    revisedPrompt: Array.isArray(result?.revisedPrompts) ? (result.revisedPrompts.find(Boolean) || '') : '',
  };
}
