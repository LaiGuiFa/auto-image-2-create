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

export function renderDetailModalHtml(model) {
  return `
    <div class="detail-layout">
      <section class="detail-preview">
        <div class="detail-preview-toolbar">
          <button type="button" class="detail-nav-btn" data-detail-nav="prev" ${model.imageCount <= 1 || model.imageIndex <= 0 ? 'disabled' : ''}>上一张</button>
          <span class="detail-page-info">${model.imageCount ? `${model.imageIndex + 1} / ${model.imageCount}` : '0 / 0'}</span>
          <button type="button" class="detail-nav-btn" data-detail-nav="next" ${model.imageCount <= 1 || model.imageIndex >= model.imageCount - 1 ? 'disabled' : ''}>下一张</button>
        </div>
        <div class="detail-preview-stage">
          ${model.activeImage?.url
            ? `<img class="detail-preview-image" src="${escapeHtml(model.activeImage.url)}" alt="">`
            : '<div class="detail-preview-empty">图片不可用</div>'}
        </div>
      </section>
      <section class="detail-meta">
        <div class="detail-section">
          <h3>记录信息</h3>
          <div class="detail-param-row">
            <div class="detail-param-label">状态</div>
            <div class="detail-param-value"><strong>${escapeHtml(model.status || '未知')}</strong></div>
          </div>
          <div class="detail-param-row">
            <div class="detail-param-label">分辨率</div>
            <div class="detail-param-value"><strong>${escapeHtml(model.resolution || '未知')}</strong></div>
          </div>
          <div class="detail-param-row">
            <div class="detail-param-label">生成时长</div>
            <div class="detail-param-value">${escapeHtml(model.duration || '未知')}</div>
          </div>
        </div>
        <div class="detail-section">
          <h3>图片参数</h3>
          ${renderParamRows(model)}
        </div>
        <div class="detail-section">
          <h3>原始 Prompt</h3>
          <pre class="detail-text-block">${escapeHtml(model.prompt || '(无)')}</pre>
        </div>
        ${model.showRevisedPrompt ? `
          <div class="detail-section">
            <h3>上游改写后 Prompt</h3>
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

export function bindDetailModalEvents({ modalEl, modalBody, getRecordById, detailState, onClose }) {
  modalBody.addEventListener('click', (event) => {
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
