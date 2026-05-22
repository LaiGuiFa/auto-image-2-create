import { buildDetailViewModel } from './detail-record.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function renderParamRows(model) {
  if (!model.displayParams.length) {
    return '<div class="detail-empty-text">暂无参数信息</div>';
  }

  return model.displayParams.map((item) => `
    <div class="detail-param-row">
      <div class="detail-param-label">${escapeHtml(item.label)}</div>
      <div class="detail-param-value">
        <strong>${escapeHtml(item.actual ?? item.requested ?? '-')}</strong>
        ${item.actual && item.requested && item.actual !== item.requested
          ? `<span class="detail-param-requested">请求值 ${escapeHtml(item.requested)}</span>`
          : ''}
      </div>
    </div>
  `).join('');
}

function renderRecordMeta(model) {
  const items = [
    model.resolution ? `分辨率 ${escapeHtml(model.resolution)}` : '',
    model.duration ? `生成时长 ${escapeHtml(model.duration)}` : '',
  ].filter(Boolean);

  if (!items.length) return '';
  return `<div class="detail-section-meta">${items.join('<span class="detail-section-meta-gap"></span>')}</div>`;
}

export function renderDetailModalHtml(model) {
  return `
    <div class="detail-layout">
      <section class="detail-preview">
        <div class="detail-preview-toolbar">
          <button type="button" class="detail-nav-btn" data-detail-nav="prev" ${model.imageCount <= 1 || model.imageIndex <= 0 ? 'disabled' : ''}>上一张</button>
          <span class="detail-page-info">${model.imageCount ? `${model.imageIndex + 1} / ${model.imageCount}` : '0 / 0'}</span>
          <button type="button" class="detail-nav-btn" data-detail-nav="next" ${model.imageCount <= 1 || model.imageIndex >= model.imageCount - 1 ? 'disabled' : ''}>下一张</button>
        </div>
        <div class="detail-preview-stage${model.activeImage?.url ? ' has-image' : ''}">
          ${model.activeImage?.url ? `
            <div class="detail-preview-download-mask" aria-hidden="true">
              <button type="button" class="detail-preview-download-btn" data-detail-download title="下载">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            </div>
          ` : ''}
          ${model.activeImage?.url
            ? `<img class="detail-preview-image" src="${escapeHtml(model.activeImage.url)}" alt="">`
            : '<div class="detail-preview-empty">图片不可用</div>'}
        </div>
      </section>
      <section class="detail-meta">
        <div class="detail-section">
          <div class="detail-section-head">
            <h3>记录信息</h3>
            ${renderRecordMeta(model)}
          </div>
        </div>
        <div class="detail-section">
          <h3>图片参数</h3>
          ${renderParamRows(model)}
        </div>
        <div class="detail-section">
          <h3>原始 Prompt</h3>
          <pre class="detail-text-block">${escapeHtml(model.prompt || '(空)')}</pre>
        </div>
        ${model.showRevisedPrompt ? `
          <div class="detail-section">
            <h3>自动优化</h3>
            <pre class="detail-text-block">${escapeHtml(model.revisedPrompt)}</pre>
          </div>
        ` : ''}
      </section>
    </div>
  `;
}

export function renderDetailModal({ modalBody, record, imageIndex }) {
  const model = buildDetailViewModel(record, imageIndex);
  modalBody.innerHTML = renderDetailModalHtml(model);
  return model;
}

export function bindDetailModalEvents({ modalEl, modalBody, getRecordById, detailState, onClose, onDownloadImage }) {
  let hoverTimer = null;
  let hoverTarget = null;

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverTarget = null;
  }

  function setPreviewDownloadVisible(visible) {
    const btn = modalBody.querySelector('[data-detail-download]');
    if (!btn) return;
    btn.classList.toggle('is-visible', visible);
  }

  modalBody.addEventListener('mousemove', (event) => {
    const stage = event.target.closest('.detail-preview-stage');
    if (!stage) {
      clearHoverTimer();
      setPreviewDownloadVisible(false);
      return;
    }
    if (stage.contains(event.target)) {
      if (!hoverTimer && hoverTarget !== stage) {
        hoverTarget = stage;
        hoverTimer = setTimeout(() => {
          setPreviewDownloadVisible(true);
          hoverTimer = null;
        }, 500);
      }
      return;
    }
    clearHoverTimer();
    setPreviewDownloadVisible(false);
  });

  modalBody.addEventListener('mouseleave', () => {
    clearHoverTimer();
    setPreviewDownloadVisible(false);
  });

  modalBody.addEventListener('click', (event) => {
    const downloadBtn = event.target.closest('[data-detail-download]');
    if (downloadBtn) {
      const snapshot = detailState.getSnapshot();
      const record = getRecordById(snapshot.recordId);
      const activeImage = record?.images?.[snapshot.imageIndex];
      if (activeImage && typeof onDownloadImage === 'function') {
        onDownloadImage(activeImage, record?.format, snapshot.imageIndex);
      }
      return;
    }

    const nav = event.target.closest('[data-detail-nav]');
    if (!nav) return;

    const snapshot = detailState.getSnapshot();
    const record = getRecordById(snapshot.recordId);
    if (!record) return;

    const nextIndex = nav.getAttribute('data-detail-nav') === 'prev'
      ? detailState.prev()
      : detailState.next();

    renderDetailModal({ modalBody, record, imageIndex: nextIndex });
  });

  modalEl.addEventListener('click', (event) => {
    if (event.target !== modalEl) return;
    detailState.close();
    modalEl.classList.remove('open');
    onClose?.();
  });
}
