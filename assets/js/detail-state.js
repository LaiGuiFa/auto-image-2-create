function clampIndex(index, imageCount) {
  if (!Number.isFinite(index)) return 0;
  if (!Number.isFinite(imageCount) || imageCount <= 0) return 0;
  return Math.max(0, Math.min(imageCount - 1, index));
}

export function createDetailState() {
  const snapshot = {
    open: false,
    recordId: null,
    imageIndex: 0,
    imageCount: 0,
  };

  return {
    getSnapshot() {
      return { ...snapshot };
    },
    open({ recordId, imageIndex = 0, imageCount = 1 }) {
      snapshot.open = true;
      snapshot.recordId = recordId;
      snapshot.imageCount = imageCount > 0 ? imageCount : 1;
      snapshot.imageIndex = clampIndex(imageIndex, snapshot.imageCount);
    },
    close() {
      snapshot.open = false;
    },
    prev() {
      snapshot.imageIndex = clampIndex(snapshot.imageIndex - 1, snapshot.imageCount);
      return snapshot.imageIndex;
    },
    next() {
      snapshot.imageIndex = clampIndex(snapshot.imageIndex + 1, snapshot.imageCount);
      return snapshot.imageIndex;
    },
    setImageIndex(index) {
      snapshot.imageIndex = clampIndex(index, snapshot.imageCount);
      return snapshot.imageIndex;
    },
  };
}
