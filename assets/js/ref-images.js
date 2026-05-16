export function getReferenceImageAddState({ currentCount, asyncMode, asyncDisabled }) {
  const max = asyncMode === 'async' && !asyncDisabled ? 10 : 1;
  const count = Math.max(0, Number(currentCount) || 0);
  if (count >= max) {
    return {
      ok: false,
      max,
      reason: max === 1 ? '同步模式最多 1 张参考图' : `最多 ${max} 张参考图`,
    };
  }
  return { ok: true, max, reason: '' };
}

export function makeHistoryReferenceImage({ recordId, index, dataUrl }) {
  const id = String(recordId || 'history').slice(0, 8);
  const displayIndex = Math.max(0, Number(index) || 0) + 1;
  return {
    name: `历史图片 ${id}-${displayIndex}`,
    url: dataUrl,
    source: 'history',
  };
}
