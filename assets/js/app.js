import {
  VERSION,
  CHANNEL,
  KV_ASYNC_MODE,
  KV_ASYNC_DISABLED,
  KV_USAGE_STATS,
  KV_DOWNLOAD_DIR,
  KV_BUNDLED_VERSION,
  KV_RELEASE_ACK_VERSION,
  RELEASE_JSON_PATH,
  POLL_INTERVAL,
  POLL_JITTER_MAX,
  POLL_MAX,
  REF_UPLOAD_MAX_BYTES,
  MODAL_GALLERY_PAGE_SIZE,
  CANVAS_INITIAL_IMAGE_LIMIT,
  EYE_OPEN,
  EYE_SHUT,
  PLAY_ICON,
  SIZE_RATIO_PRESETS,
  SIZE_PIXEL_PRESETS,
  SIZE_CUSTOM_PX_MIN,
  SIZE_CUSTOM_PX_MAX,
  SIZE_PIXEL_BUDGET_MIN,
  SIZE_PIXEL_BUDGET_MAX,
  CND_PX_TO_RATIO,
  CND_RATIO_TO_PX,
} from './config.js';
import { isAsyncModeDisabled, resolveAllowedAsyncMode } from './async-mode-policy.js';
import {
  genId,
  base64ToBlob,
  esc,
  escapeAttr,
  cardWidth,
  parseAspectRatio,
  compareSemver,
} from './utils.js';
import {
  attachRequestMetadata,
  buildAsyncPayload,
  buildPollRequestUrl,
  buildSyncPayload,
  hasReferenceImages,
} from './upstream-payload.js';
import { createDetailState } from './detail-state.js?v=20260515-detail-info';
import { createDetailRecordPayload } from './detail-record.js?v=20260515-detail-info';
import { bindDetailModalEvents, renderDetailModal } from './detail-modal.js?v=20260515-detail-info';
import { getReferenceImageAddState, makeHistoryReferenceImage } from './ref-images.js?v=20260515-detail-info';
import { filterHistoryRecordsByPrompt } from './history-gallery.js?v=20260522-history-search';
import { normalizePolishText } from './prompt-polish.js?v=20260515-polish';
import { buildQueueTaskRequestInit } from './task-queue-request.js';
import { normalizeRuntimeConfig, getProviderById } from './runtime-config.js';
import {
  KV_SELECTED_PROVIDER,
  getProviderApiKeyStorageKey,
  resolveSelectedProvider,
} from './provider-settings.js';
import {
  buildPolishRequest,
  getPolishButtonLabel,
  getPolishDisabledState,
  readPolishResponseText,
} from './prompt-polish-ui.js';
import { createQueueTaskSnapshot, createTaskQueueController } from './task-queue.js';
import { renderTaskQueueInto } from './task-queue-ui.js';
import db from './db.js';
import Viewer from '/vendor/viewerjs/viewer.esm.js';

// ─────────────────────────────────────────────────────────────────────────────
// Application State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  channel: 'cnd',
  asyncMode: 'async',           // 'sync' | 'async'；default 异步
  asyncDisabled: false,
  keys: { cnd: '' },
  providers: [],
  defaultProviderId: 'cnd',
  selectedProviderId: 'cnd',
  deepseekConfigured: false,
  size: '1:1',
  quality: 'low',
  format: 'PNG',
  compression: 100,
  count: 1,
  loading: false,          // true only while a sync request is in flight
  refImages: [],
  sizeMode: 'ratio',  // 'ratio' | 'pixel'
  ratioSize: '1:1',        // last explicit ratio selection (independent of pixel mode)
  pixelSize: '1024x1792',  // last explicit pixel selection (independent of ratio mode)
  moderation:    false,    // 当前接口：true = 开启 moderation 参数
  streamEnabled: false,    // 当前接口：流式 + partial_images
  /** 与生成记录分离，内存镜像 + `kv` 持久化 */
  usageStats: { input: 0, output: 0, total: 0 },
  downloadDir: '',
  pendingPolls: new Map(), // taskId → { timerId, attempts, cardId, finalizeState }
  queueTasks: [],
};

/** 异步模式单次最多 4 张（多任务提交）；同步模式最多 10 张（n 参数） */
function maxCount() {
  return state.asyncMode === 'async' ? 4 : 10;
}

function syncCountStepperUi() {
  const cap = maxCount();
  const elMinus = document.getElementById('minusBtn');
  const elPlus  = document.getElementById('plusBtn');
  const elVal   = document.getElementById('countVal');
  const elMax   = document.getElementById('maxCount');
  if (!elMinus || !elPlus || !elVal) return;
  elVal.textContent = state.count;
  elMinus.disabled = state.count <= 1;
  elPlus.disabled  = state.count >= cap;
  if (elMax) elMax.textContent = String(cap);
}

function clampCount() {
  const cap = maxCount();
  state.count = Math.min(cap, Math.max(1, state.count));
  syncCountStepperUi();
}

let _refUploadBusy = false;
let _activeSyncRow = null;
let _historyGalleryPage = 1;
let _historyRecords = null;
let _historySearchQuery = '';
let _historyModalObjectUrls = [];
let _historyPanelObjectUrls = [];
let _collectionItems = [];
let _collectionMap = new Map();
let _detailModalObjectUrls = [];
let _cacheSizeDirty = true;
let _settingsDraft = null;
let _polishLoading = false;
let _cacheSizeText = '—';
let _asyncFinalizeRunning = false;
const _asyncFinalizeQueue = [];
const _detailState = createDetailState();
let _detailRecordCache = null;
let _taskQueueController = null;

// Cached example data

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function resetHistoryModalObjectUrls() {
  _historyModalObjectUrls.forEach(revokeObjectUrl);
  _historyModalObjectUrls = [];
}

function resetHistoryPanelObjectUrls() {
  _historyPanelObjectUrls.forEach(revokeObjectUrl);
  _historyPanelObjectUrls = [];
}

function resetDetailModalObjectUrls() {
  _detailModalObjectUrls.forEach(revokeObjectUrl);
  _detailModalObjectUrls = [];
}

function setHistoryRecords(records) {
  _historyRecords = Array.isArray(records) ? records : null;
}

function getPromptElements() {
  return [
    document.getElementById('promptBottom'),
  ].filter(Boolean);
}

function getPromptValue() {
  return document.getElementById('promptBottom')?.value ?? '';
}

function syncPromptValue(value) {
  for (const el of getPromptElements()) {
    if (el.value !== value) el.value = value;
  }
  updateCharCount();
}

function syncComposerSummary() {
  const ratioEl = document.getElementById('composerRatio');
  const qualityEl = document.getElementById('composerQuality');
  const formatEl = document.getElementById('composerFormat');
  const refsEl = document.getElementById('composerRefs');
  if (ratioEl) ratioEl.textContent = state.size || 'auto';
  if (qualityEl) qualityEl.textContent = state.quality || '-';
  if (formatEl) formatEl.textContent = state.format || '-';
  if (refsEl) refsEl.textContent = `参考图 ${state.refImages.length}`;
}

function collectionKey(recordId, imageIndex) {
  return `${recordId || ''}:${Number(imageIndex) || 0}`;
}

function isCollected(recordId, imageIndex) {
  return _collectionMap.has(collectionKey(recordId, imageIndex));
}

function syncPromptToolButtons() {
  const map = [
    ['clearPromptBtn', clearPrompt],
    ['clearPromptBtnBottom', clearPrompt],
    ['quickPolishPromptBtn', () => void quickPolishPrompt()],
    ['quickPolishPromptBtnBottom', () => void quickPolishPrompt()],
    ['refImageBtn', handleRefImageBtnClick],
    ['refImageBtnBottom', handleRefImageBtnClick],
  ];
  for (const [id, handler] of map) {
    const btn = document.getElementById(id);
    if (btn && !btn.dataset.bound) {
      btn.addEventListener('click', handler);
      btn.dataset.bound = '1';
    }
  }
}

function syncPromptInputEvents() {
  const bottom = document.getElementById('promptBottom');
  if (bottom && !bottom.dataset.bound) {
    bottom.addEventListener('input', () => syncPromptValue(bottom.value));
    bottom.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
    });
    bottom.dataset.bound = '1';
  }
}

function sortCollectionItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const left = String(b?.filename || b?.id || '').trim();
    const right = String(a?.filename || a?.id || '').trim();
    return left.localeCompare(right);
  });
}

async function loadCollections() {
  try {
    const res = await fetch('/api/collection');
    const json = await res.json();
    if (!res.ok || json?.ok !== true) throw new Error(json?.error || `HTTP ${res.status}`);
    _collectionItems = sortCollectionItems(json.items);
    _collectionMap = new Map(_collectionItems.map(item => [collectionKey(item.recordId, item.imageIndex), item]));
  } catch (error) {
    console.warn('[collections]', error);
    _collectionItems = [];
    _collectionMap = new Map();
  }
}

async function renderCollectionPanel() {
  const body = document.getElementById('collectionPanelBody');
  if (!body) return;
  if (!_collectionItems.length) {
    body.innerHTML = `<div class="collection-panel-empty">暂无收藏</div>`;
    return;
  }
  const items = _collectionItems.slice(0, 8);
  body.innerHTML = items.map(item => `
    <div class="collection-panel-item" data-id="${escapeAttr(item.id)}">
      <img src="${escapeAttr(item.url)}" alt="" loading="lazy" />
      <div class="collection-panel-item-meta">
        <div class="collection-panel-item-title" title="${escapeAttr(item.prompt || '')}">${esc(item.prompt || '已收藏图片')}</div>
      </div>
    </div>
  `).join('');
  body.querySelectorAll('.collection-panel-item').forEach(node => {
    node.addEventListener('click', () => {
      const itemIndex = _collectionItems.findIndex(x => x.id === node.dataset.id);
      if (itemIndex >= 0) openLightbox(_collectionItems.map(item => item.url), itemIndex, { showPagerArrows: true });
    });
  });
}

async function refreshCollections() {
  await loadCollections();
  await renderCollectionPanel();
  syncCollectionStarStates();
}

function syncCollectionStarStates() {
  document.querySelectorAll('.image-fav-btn').forEach(btn => {
    const card = btn.closest('.image-card');
    const recId = card?.dataset?.recId;
    const imgIdx = parseInt(card?.dataset?.imgIdx || '0', 10) || 0;
    const collected = isCollected(recId, imgIdx);
    btn.classList.toggle('active', collected);
    btn.title = collected ? '取消收藏' : '收藏';
  });
}

function syncTaskQueue(tasks) {
  state.queueTasks = Array.isArray(tasks) ? [...tasks] : [];
  const container = document.getElementById('taskQueueList');
  if (container) renderTaskQueueInto(container, state.queueTasks, {
    onDeleteTask: deleteQueueTaskById,
  });
}

async function persistQueueTask(task) {
  await db.putQueueTask(task);
  markCacheSizeDirty();
}

async function deleteQueueTaskPersisted(taskId) {
  await db.deleteQueueTask(taskId);
  markCacheSizeDirty();
}

async function loadQueueTasks() {
  const rows = await db.getQueueTasksSorted().catch(() => []);
  syncTaskQueue(rows);
  return rows;
}

async function deleteQueueTaskById(taskId) {
  const controller = initTaskQueueController();
  const removed = await controller.removeTask(taskId);
  if (removed) {
    toast('任务已移除', 'info');
  }
}

function getSelectedProvider() {
  return resolveSelectedProvider({
    providers: state.providers,
    defaultProviderId: state.defaultProviderId,
    selectedProviderId: state.selectedProviderId,
  });
}

function getProviderApiKey(providerId = state.selectedProviderId) {
  return state.keys[providerId] || '';
}

async function loadRuntimeConfigState() {
  const fallback = normalizeRuntimeConfig({
    defaultProviderId: 'cnd',
    providers: [{
      id: 'cnd',
      label: CHANNEL.cnd?.name || 'Image API',
      supportsAsync: true,
    }],
    deepseekConfigured: false,
    requestTimeoutMs: 0,
    uploadRetentionDays: 2,
  });
  try {
    const res = await fetch('/api/runtime-config');
    const json = await res.json();
    if (!res.ok || json?.ok !== true) throw new Error(json?.error || `HTTP ${res.status}`);
    applyRuntimeConfig(normalizeRuntimeConfig(json));
  } catch (error) {
    applyRuntimeConfig(fallback);
    console.warn('[runtime config]', error);
  }
}

function applyRuntimeConfig(config) {
  state.providers = config.providers;
  state.defaultProviderId = config.defaultProviderId;
  state.deepseekConfigured = config.deepseekConfigured;
  if (!getProviderById(state.providers, state.selectedProviderId)) {
    state.selectedProviderId = state.defaultProviderId;
  }
  syncRuntimeConfigUi(config);
}

function syncRuntimeConfigUi(config) {
  const expireEl = document.getElementById('refUploadExpire');
  if (expireEl && config.uploadRetentionDays > 0) {
    expireEl.textContent = String(config.uploadRetentionDays * 24);
  }
  syncPolishButtons();
}

async function hydrateProviderSettings() {
  if (!db.hasDb()) {
    state.selectedProviderId = state.defaultProviderId;
    return;
  }
  for (const provider of state.providers) {
    const key = await db.kvGet(getProviderApiKeyStorageKey(provider.id));
    if (key) state.keys[provider.id] = key;
  }
  const legacyKey = await db.kvGet(CHANNEL.cnd.lsKey);
  if (legacyKey && !state.keys[state.defaultProviderId]) {
    state.keys[state.defaultProviderId] = legacyKey;
  }
  const savedProviderId = await db.kvGet(KV_SELECTED_PROVIDER);
  const provider = resolveSelectedProvider({
    providers: state.providers,
    defaultProviderId: state.defaultProviderId,
    selectedProviderId: savedProviderId,
  });
  state.selectedProviderId = provider?.id || state.defaultProviderId;
}

function resolveProviderAwareAsyncMode(mode) {
  return resolveAllowedAsyncMode(mode, state.asyncDisabled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
(async function init() {
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = VERSION;

  await db.init();
  await loadRuntimeConfigState();
  if (db.hasDb()) {
    // 清理旧渠道遗留的 KV 条目（duomi / custom 渠道已移除）
    try {
      await Promise.all([
        db.kvRemove('cnd_ai_duomi_key'),
        db.kvRemove('cnd_ai_custom_key'),
        db.kvRemove('cnd_ai_custom_base_url'),
        db.kvRemove('cnd_ai_channel'),
      ]);
    } catch (_) { /* non-critical */ }
    try {
      await db.hydrateState(state, CHANNEL);
      await hydrateProviderSettings();
      // Restore async mode
      const savedMode = await db.kvGet(KV_ASYNC_MODE);
      if (savedMode === 'sync' || savedMode === 'async') state.asyncMode = savedMode;
      const asyncDisabledRaw = await db.kvGet(KV_ASYNC_DISABLED);
      state.asyncDisabled = asyncDisabledRaw === 'true';
      state.downloadDir = String(await db.kvGet(KV_DOWNLOAD_DIR) || '').trim();
      state.asyncMode = resolveProviderAwareAsyncMode(state.asyncMode);
      // Sync mode-specific size vars from restored state (these fields are new, not in DB)
      if (state.sizeMode === 'pixel') {
        if (state.size && state.size.includes('x')) state.pixelSize = state.size;
        else state.size = state.pixelSize;
      } else {
        if (state.size && (state.size.includes(':') || state.size === 'auto')) state.ratioSize = state.size;
        else state.size = state.ratioSize;
      }
    } catch (e) { console.warn('[hydrate state]', e); }
    try {
      await db.kvSet(KV_BUNDLED_VERSION, VERSION);
    } catch (e) { console.warn('[kv bundled version]', e); }
  } else {
    toast('IndexedDB 不可用，设置与记录无法保存', 'error', 6000);
  }

  // ── Wire up all event listeners ──
  wireEvents();

  // ── Sync UI ──
  syncModeButtons();
  updateKeyStatus();
  updateRefImageButton();
  clampCount();
  syncSizeSection();
  syncFormatSection();
  syncCompressionSection();
  syncExperimentalSection();
  syncPromptValue(document.getElementById('promptBottom')?.value || '');
  syncComposerSummary();

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const hint  = document.getElementById('shortcutHint');
  if (hint) hint.innerHTML = isMac
    ? '<kbd>⌘</kbd> <kbd>Return</kbd>'
    : '<kbd>Ctrl</kbd> + <kbd>Enter</kbd>';

  await loadRecordsToCanvas();
  updateCumulativeTokens();
  void renderHistoryPanel();
  await refreshCollections();
  initTaskQueueController();
  await _taskQueueController.restoreAndStart();

  await maybeShowReleaseNotes();

  // Final scroll after all rows (completed + pending) are in the DOM
  requestAnimationFrame(() => scrollToLatest(true));
})();

// ─────────────────────────────────────────────────────────────────────────────
// Event Wiring (all addEventListener — no inline onclick in HTML)
// ─────────────────────────────────────────────────────────────────────────────
function wireEvents() {
  // Mode selector (sync / async)
  document.getElementById('asyncModeSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-async-mode]');
    if (btn && !btn.disabled) void setAsyncMode(btn.dataset.asyncMode, true);
  });

  // Settings open / close
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettings);
  // Settings actions
  document.getElementById('saveSettingsBtn').addEventListener('click', () => void saveSettings());
  document.getElementById('clearKeyBtn').addEventListener('click', () => void clearCurrentKey());
  document.getElementById('clearRecordsBtn').addEventListener('click', clearAllRecords);
  document.getElementById('pickDownloadDirBtn').addEventListener('click', () => void pickDownloadDirectory());
  document.getElementById('providerSelect').addEventListener('change', syncSettingsDraftProvider);
  document.getElementById('disableAsyncToggle').addEventListener('change', () => {
    if (_settingsDraft) _settingsDraft.asyncDisabled = document.getElementById('disableAsyncToggle').checked;
  });

  // Eye toggle button
  const cndEyeBtn = document.getElementById('modalCndEyeBtn');
  if (cndEyeBtn) cndEyeBtn.addEventListener('click', () => toggleEye('modalCndKey', cndEyeBtn));

  // Enter-to-save on API key input
  const cndKeyEl = document.getElementById('modalCndKey');
  if (cndKeyEl) cndKeyEl.addEventListener('keydown', e => { if (e.key === 'Enter') void saveSettings(); });
  if (cndKeyEl) cndKeyEl.addEventListener('input', () => {
    if (!_settingsDraft) return;
    _settingsDraft.keys[_settingsDraft.providerId] = cndKeyEl.value.trim();
  });

  // Size mode segment
  document.getElementById('sizeModeSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-size-mode]');
    if (!btn) return;
    const newMode = btn.dataset.sizeMode;
    if (newMode === state.sizeMode) return;
    // Save current value to the outgoing mode's store
    if (state.sizeMode === 'ratio' && state.size && (state.size.includes(':') || state.size === 'auto')) {
      state.ratioSize = state.size;
    } else if (state.sizeMode === 'pixel' && state.size && state.size.includes('x')) {
      state.pixelSize = state.size;
    }
    state.sizeMode = newMode;
    // Restore from incoming mode's store — no conversion, fully independent
    state.size = newMode === 'ratio' ? state.ratioSize : state.pixelSize;
    document.getElementById('customSizeError').textContent = '';
    syncSizeSection();
  });

  // Ratio chips（事件代理，因为 innerHTML 动态渲染）
  document.getElementById('ratioPanel').addEventListener('click', e => {
    const chip = e.target.closest('[data-ratio]');
    if (!chip) return;
    state.size = chip.dataset.ratio;
    state.ratioSize = state.size;
    renderRatioPanel();
  });

  // Pixel preset tiles
  document.getElementById('pixelPresetGrid').addEventListener('click', e => {
    const tile = e.target.closest('[data-size-px]');
    if (!tile) return;
    state.size = tile.dataset.sizePx;
    state.pixelSize = state.size;
    document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el =>
      el.classList.toggle('active', el.dataset.sizePx === state.size));
    document.getElementById('customWidthInput').value  = '';
    document.getElementById('customHeightInput').value = '';
    document.getElementById('customSizeError').textContent = '';
  });

  // Custom size apply
  document.getElementById('customSizeApplyBtn').addEventListener('click', applyCustomSize);
  document.getElementById('customWidthInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomSize();
  });
  document.getElementById('customHeightInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomSize();
  });

  // Quality seg
  document.querySelectorAll('[data-q]').forEach(el =>
    el.addEventListener('click', () => selectQuality(el)));

  // Format seg
  document.querySelectorAll('[data-fmt]').forEach(el =>
    el.addEventListener('click', () => selectFormat(el)));

  // Compression slider
  document.getElementById('compression').addEventListener('input', function () {
    document.getElementById('compressionVal').textContent = this.value;
    state.compression = parseInt(this.value);
  });

  // Count stepper
  document.getElementById('minusBtn').addEventListener('click', () => adjustCount(-1));
  document.getElementById('plusBtn').addEventListener('click',  () => adjustCount(1));

  // Prompt
  syncPromptInputEvents();
  syncPromptToolButtons();

  // Ref image button + upload modal
  document.getElementById('refUploadInput').addEventListener('change', function () {
    // 必须先复制 FileList：清空 value 后部分浏览器会清空同一 FileList，导致无法上传
    const files = this.files && this.files.length ? Array.from(this.files) : [];
    this.value = '';
    if (files.length) processRefUploadFiles(files);
  });
  const refZone = document.getElementById('refUploadZone');
  refZone.addEventListener('dragenter', e => { e.preventDefault(); refZone.classList.add('ref-upload-drag'); });
  refZone.addEventListener('dragover', e => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
  });
  refZone.addEventListener('dragleave', e => {
    if (!refZone.contains(e.relatedTarget)) refZone.classList.remove('ref-upload-drag');
  });
  refZone.addEventListener('drop', e => {
    e.preventDefault();
    refZone.classList.remove('ref-upload-drag');
    if (_refUploadBusy) return;
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) processRefUploadFiles(dt.files);
  });
  document.getElementById('refUploadModalCloseX').addEventListener('click', closeRefUploadModal);
  document.getElementById('refUploadModalCloseBtn').addEventListener('click', closeRefUploadModal);

  document.getElementById('releaseNotesOkBtn').addEventListener('click', () => void dismissReleaseNotesModal());
  document.getElementById('releaseNotesCloseBtn').addEventListener('click', () => void dismissReleaseNotesModal());
  document.getElementById('releaseNotesModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) void dismissReleaseNotesModal();
  });

  // Generate button
  document.getElementById('genBtn').addEventListener('click', generate);

  // Toolbar
  document.getElementById('clearBtn').addEventListener('click', clearCanvas);
  document.getElementById('toolbarBadge').addEventListener('click', openHistoryModal);
  document.getElementById('historyPanelBtn').addEventListener('click', openHistoryModal);
  document.getElementById('collectionPanelBtn').addEventListener('click', () => {
    const first = _collectionItems[0];
    if (first) openLightbox(_collectionItems.map(item => item.url), 0, { showPagerArrows: true });
    else toast('暂无收藏', 'info');
  });

  // Detail modal
  document.getElementById('detailCloseBtn').addEventListener('click', closeDetailModal);
  bindDetailModalEvents({
    modalEl: document.getElementById('detailModal'),
    modalBody: document.getElementById('detailModalBody'),
    detailState: _detailState,
    getRecordById: (recordId) => (_detailRecordCache?.id === recordId ? _detailRecordCache : null),
    onDownloadImage: (imageRef, fmt, idx) => void downloadImageRef(imageRef, fmt, idx),
    onClose: () => {
      resetDetailModalObjectUrls();
      _detailRecordCache = null;
    },
  });
  // Prompt polish modal
  document.getElementById('polishCloseBtn').addEventListener('click', closePolishModal);
  document.getElementById('polishCancelBtn').addEventListener('click', closePolishModal);
  document.getElementById('polishApplyBtn').addEventListener('click', applyPolishedPrompt);
  document.getElementById('polishRunBtn').addEventListener('click', () => void runPromptPolish());
  document.getElementById('polishModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePolishModal();
  });
  // History modal
  document.getElementById('historyCloseBtn').addEventListener('click', closeHistoryModal);
  document.getElementById('historyModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeHistoryModal();
  });

  // Global keyboard
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeLightbox();
    closeSettings();
    closeDetailModal();
    closePolishModal();
    closeHistoryModal();
    closeRefUploadModal();
    void dismissReleaseNotesModal();
  });

  // 实验性：moderation
  document.getElementById('cndModerationToggle').addEventListener('change', function () {
    state.moderation = this.checked;
  });

  // 实验性：stream
  document.getElementById('cndStreamToggle').addEventListener('change', function () {
    state.streamEnabled = this.checked;
  });

  // 同步生成进行中：离开 / 刷新 / 关闭标签页时由浏览器弹出原生确认框（无法真正拦截，用户仍可确认离开）
  window.addEventListener('beforeunload', e => {
    if (!state.loading) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Mode
// ─────────────────────────────────────────────────────────────────────────────
async function setAsyncMode(mode, showToast = false) {
  const nextMode = resolveProviderAwareAsyncMode(mode);
  if (state.asyncMode === nextMode) return;
  state.asyncMode = nextMode;
  if (db.hasDb()) {
    try { await db.kvSet(KV_ASYNC_MODE, nextMode); } catch (e) { console.warn('[kv async mode]', e); }
  }
  syncModeButtons();
  clampCount();
  syncFormatSection();
  syncCompressionSection();
  if (showToast) toast(nextMode === 'async' ? '已切换到异步生图' : '已切换到同步生图', 'info');
}

function syncModeButtons() {
  const disabled = isAsyncModeDisabled(state.asyncDisabled);
  document.querySelectorAll('#asyncModeSeg [data-async-mode]').forEach(b => {
    const isAsyncBtn = b.dataset.asyncMode === 'async';
    b.classList.toggle('active', b.dataset.asyncMode === state.asyncMode);
    b.disabled = disabled && isAsyncBtn;
    b.title = disabled && isAsyncBtn ? '已在设置中禁用异步模式' : '';
  });
}

function updateKeyStatus() {
  const hasKey = !!getProviderApiKey();
  const dot    = document.getElementById('keyDot');
  const btn    = document.getElementById('settingsBtn');
  dot.classList.toggle('active', hasKey);
  dot.title = hasKey ? 'API Key 已配置' : 'API Key 未配置';
  btn.classList.toggle('has-key', hasKey);
}

function updateRefImageButton() {
  ['refImageBtn', 'refImageBtnBottom'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.add('ref-supported');
    btn.classList.remove('ref-disabled');
    btn.title = '添加参考图';
  });
}

function handleRefImageBtnClick() {
  openRefUploadModal();
}

function openRefUploadModal() {
  const maxRef = state.asyncMode === 'async' ? 10 : 1;
  document.getElementById('refUploadModal').classList.add('open');
  document.getElementById('refUploadInput').value = '';
  document.getElementById('refUploadZone').classList.remove('ref-upload-drag');
  const hintEl = document.querySelector('#refUploadModal .ref-upload-zone-hint');
  if (hintEl) {
    hintEl.textContent = `JPG / JPEG / PNG，单张不超过 5MB，最多 ${maxRef} 张`;
  }
}

function closeRefUploadModal() {
  document.getElementById('refUploadModal').classList.remove('open');
  document.getElementById('refUploadZone').classList.remove('ref-upload-drag');
}

/** release.json 中 `type` → 列表前缀文案 */
const RELEASE_TYPE_LABEL = {
  add: '[新增]',
  optimize: '[优化]',
  fix: '[修复]',
  refactor: '[重构]',
  change: '[变更]',
  doc: '[文档]',
  security: '[安全]',
  remove: '[移除]',
  deprecate: '[废弃]',
  perf: '[性能]',
  style: '[样式]',
  deps: '[依赖]',
  breaking: '[破坏性变更]',
  chore: '[杂项]',
  test: '[测试]',
};

let _releaseNotesAckOnDismiss = null;

function releaseTypeLabel(type) {
  const t = String(type || '').toLowerCase();
  return RELEASE_TYPE_LABEL[t] || `[${esc(t || '其他')}]`;
}

function normalizeReleaseEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(e => e && typeof e.version === 'string' && e.version.trim());
}

/** 取「尚未确认已读」的最新一条（semver 最大） */
function pickLatestUnackedRelease(entries, ackVersion) {
  const ack = (ackVersion && String(ackVersion).trim()) || '0.0.0';
  const unseen = entries.filter(e => compareSemver(e.version, ack) > 0);
  if (!unseen.length) return null;
  unseen.sort((a, b) => compareSemver(b.version, a.version));
  return unseen[0];
}

function renderReleaseNotesModal(entry) {
  const heading = document.getElementById('releaseNotesHeading');
  const meta = document.getElementById('releaseNotesMeta');
  const list = document.getElementById('releaseNotesList');
  heading.textContent = '版本更新';
  const time = entry.update_time ? esc(String(entry.update_time)) : '';
  meta.innerHTML = time
    ? `<span class="release-notes-ver">v${esc(entry.version)}</span><span class="release-notes-time">${time}</span>`
    : `<span class="release-notes-ver">v${esc(entry.version)}</span>`;
  const items = Array.isArray(entry.update_content) ? entry.update_content : [];
  list.innerHTML = items
    .map(row => {
      if (!row || typeof row.text !== 'string') return '';
      const tag = releaseTypeLabel(row.type);
      return `<li class="release-notes-item"><span class="release-notes-type">${tag}</span><span>${esc(row.text)}</span></li>`;
    })
    .filter(Boolean)
    .join('') || `<li class="release-notes-item release-notes-empty">暂无说明条目</li>`;
}

function openReleaseNotesModal(entry) {
  _releaseNotesAckOnDismiss = entry.version;
  renderReleaseNotesModal(entry);
  document.getElementById('releaseNotesModal').classList.add('open');
}

async function dismissReleaseNotesModal() {
  const modal = document.getElementById('releaseNotesModal');
  if (!modal.classList.contains('open')) return;
  const v = _releaseNotesAckOnDismiss;
  modal.classList.remove('open');
  _releaseNotesAckOnDismiss = null;
  if (v && db.hasDb()) {
    try {
      await db.kvSet(KV_RELEASE_ACK_VERSION, String(v));
    } catch (e) {
      console.warn('[kv release ack]', e);
    }
  }
  location.reload();
}

async function maybeShowReleaseNotes() {
  if (!db.hasDb()) return;
  let ackRaw;
  try {
    ackRaw = await db.kvGet(KV_RELEASE_ACK_VERSION);
  } catch {
    return;
  }
  const url = new URL(RELEASE_JSON_PATH, window.location.href);
  url.searchParams.set('_', String(Date.now()));
  let data;
  try {
    const res = await fetch(url.href, { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const entries = normalizeReleaseEntries(data);
  const next = pickLatestUnackedRelease(entries, ackRaw);
  if (!next) return;
  openReleaseNotesModal(next);
}

function setRefUploadBusy(busy) {
  _refUploadBusy = busy;
  const zone = document.getElementById('refUploadZone');
  const busyEl = document.getElementById('refUploadBusy');
  if (zone) zone.classList.toggle('ref-upload-disabled', busy);
  if (busyEl) busyEl.style.display = busy ? 'flex' : 'none';
}

function isValidRefUploadFile(file) {
  const mime = (file.type || '').toLowerCase().trim();
  const extOk = /\.(jpe?g|png)$/i.test(file.name || '');
  const mimeOk = mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/pjpeg';
  if (mime.startsWith('image/') && !mimeOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG、PNG' };
  }
  if (!mimeOk && !extOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG、PNG' };
  }
  if (file.size > REF_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: '单张不能超过 5MB' };
  }
  if (file.size <= 0) {
    return { ok: false, reason: '文件无效' };
  }
  return { ok: true };
}

async function uploadRefFileToServer(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  let json = {};
  try {
    json = await res.json();
  } catch (_) { /* ignore */ }
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  if (!json.url || typeof json.url !== 'string') {
    throw new Error('服务器未返回有效链接');
  }
  return json.url;
}

async function processRefUploadFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.size > 0);
  if (!files.length) return;

  const maxRef = state.asyncMode === 'async' ? 10 : 1;
  const slots = maxRef - state.refImages.length;
  if (slots <= 0) {
    toast(`最多 ${maxRef} 张参考图`, 'info');
    return;
  }

  const toProcess = files.slice(0, slots);
  if (files.length > slots) {
    toast(`已达上限，仅处理前 ${slots} 张`, 'info');
  }

  const validFiles = [];
  for (const file of toProcess) {
    const v = isValidRefUploadFile(file);
    if (!v.ok) {
      toast(`${file.name}: ${v.reason}`, 'error');
      continue;
    }
    validFiles.push(file);
  }
  if (!validFiles.length) return;

  setRefUploadBusy(true);
  let added = 0;
  try {
    for (const file of validFiles) {
      if (state.refImages.length >= maxRef) break;
      try {
        const url = await uploadRefFileToServer(file);
        state.refImages.push({ name: file.name, url });
        renderRefImages();
        added++;
      } catch (err) {
        toast(`${file.name}: ${err.message || '上传失败'}`, 'error');
      }
    }
    if (added) {
      toast(`已添加 ${added} 张参考图`, 'success');
      closeRefUploadModal();
    }
  } finally {
    setRefUploadBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Modal
// ─────────────────────────────────────────────────────────────────────────────
function openSettings() {
  _settingsDraft = {
    providerId: state.selectedProviderId,
    keys: { ...state.keys },
    asyncDisabled: state.asyncDisabled,
    downloadDir: state.downloadDir,
  };
  syncSettingsModalUi();
  void updateCacheSize();
  document.getElementById('settingsModal').classList.add('open');
  setTimeout(() => document.getElementById('modalCndKey')?.focus(), 60);
}

function closeSettings() {
  _settingsDraft = null;
  document.getElementById('settingsModal').classList.remove('open');
}

function syncSettingsDraftProvider() {
  if (!_settingsDraft) return;
  const keyEl = document.getElementById('modalCndKey');
  if (keyEl) _settingsDraft.keys[_settingsDraft.providerId] = keyEl.value.trim();
  _settingsDraft.providerId = document.getElementById('providerSelect').value;
  syncSettingsModalUi();
}

function syncSettingsModalUi() {
  if (!_settingsDraft) return;
  const providerSelect = document.getElementById('providerSelect');
  providerSelect.innerHTML = state.providers.map(provider =>
    `<option value="${escapeAttr(provider.id)}">${esc(provider.label)}</option>`).join('');
  providerSelect.value = _settingsDraft.providerId;
  document.getElementById('modalCndKey').value = _settingsDraft.keys[_settingsDraft.providerId] || '';
  document.getElementById('disableAsyncToggle').checked = _settingsDraft.asyncDisabled;
  document.getElementById('downloadDirInput').value = _settingsDraft.downloadDir || '';
}

async function pickDownloadDirectory() {
  if (!_settingsDraft) return;
  const btn = document.getElementById('pickDownloadDirBtn');
  try {
    if (btn) btn.disabled = true;
    const res = await fetch('/api/download-directory/pick', { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok !== true) {
      if (json?.cancelled) return;
      toast(json?.error || '选择下载路径失败', 'error');
      return;
    }
    const dir = String(json.path || '').trim();
    if (!dir) return;
    _settingsDraft.downloadDir = dir;
    document.getElementById('downloadDirInput').value = dir;
  } catch (error) {
    toast(error.message || '选择下载路径失败', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveSettings() {
  if (!db.hasDb()) {
    toast('IndexedDB 不可用，无法保存设置', 'error');
    return;
  }
  if (!_settingsDraft) return;
  _settingsDraft.keys[_settingsDraft.providerId] = document.getElementById('modalCndKey').value.trim();
  const asyncDisabled = document.getElementById('disableAsyncToggle').checked;
  const provider = resolveSelectedProvider({
    providers: state.providers,
    defaultProviderId: state.defaultProviderId,
    selectedProviderId: _settingsDraft.providerId,
  });
  state.keys = { ...state.keys, ..._settingsDraft.keys };
  state.selectedProviderId = provider?.id || state.defaultProviderId;
  state.asyncDisabled = asyncDisabled;
  state.downloadDir = String(_settingsDraft.downloadDir || '').trim();

  try {
    await Promise.all(state.providers.map(async ({ id }) => {
      const key = state.keys[id] || '';
      if (key) await db.kvSet(getProviderApiKeyStorageKey(id), key);
      else await db.kvRemove(getProviderApiKeyStorageKey(id));
    }));
    await db.kvSet(KV_ASYNC_DISABLED, String(asyncDisabled));
    await db.kvSet(KV_SELECTED_PROVIDER, state.selectedProviderId);
    if (state.downloadDir) await db.kvSet(KV_DOWNLOAD_DIR, state.downloadDir);
    else await db.kvRemove(KV_DOWNLOAD_DIR);
    await db.kvRemove('cnd_ai_use_proxy');
  } catch (e) {
    toast(e.message || '设置保存失败', 'error');
    return;
  }

  state.asyncMode = resolveProviderAwareAsyncMode(state.asyncMode);
  await db.kvSet(KV_ASYNC_MODE, state.asyncMode);
  syncModeButtons();
  clampCount();
  updateKeyStatus();
  toast('设置已保存', 'success');
  closeSettings();
}

async function clearCurrentKey() {
  if (!confirm('确定清除当前的 API Key？')) return;
  const providerId = _settingsDraft?.providerId || state.selectedProviderId;
  state.keys[providerId] = '';
  if (_settingsDraft) _settingsDraft.keys[providerId] = '';
  if (db.hasDb()) await db.kvRemove(getProviderApiKeyStorageKey(providerId));
  const el = document.getElementById('modalCndKey');
  if (el) el.value = '';
  updateKeyStatus();
  toast('已清除 API Key', 'info');
}

function toggleEye(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type      = el.type === 'password' ? 'text' : 'password';
  btn.innerHTML = el.type === 'text' ? EYE_SHUT : EYE_OPEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 统一设置尺寸：感知当前渠道，自动更新 state.size 和对应 UI。
 */
function applySize(value) {
  // 当前接口支持比例和像素模式（API 端 resolveSizeForChannel 负责转换）
  const mapped = CND_PX_TO_RATIO[value];
  if (mapped) {
    // 标准像素预设 → 映射为比例展示
    state.size = mapped;
    state.ratioSize = mapped;
    state.sizeMode = 'ratio';
  } else if (value === 'auto' || value.includes(':')) {
    state.size = value;
    state.ratioSize = value;
    state.sizeMode = 'ratio';
  } else if (value.includes('x')) {
    // 自定义像素尺寸
    state.size = value;
    state.pixelSize = value;
    state.sizeMode = 'pixel';
    if (!SIZE_PIXEL_PRESETS.some(p => p.value === value)) {
      const [w, h] = value.split('x');
      const wEl = document.getElementById('customWidthInput');
      const hEl = document.getElementById('customHeightInput');
      if (wEl) wEl.value = w;
      if (hEl) hEl.value = h;
    }
  } else {
    state.size = value;
    state.ratioSize = value;
    state.sizeMode = 'ratio';
  }
  document.getElementById('customSizeError').textContent = '';
  syncSizeSection();
  syncComposerSummary();
}

// ─────────────────────────────────────────────────────────────────────────────
// Size UI
// ─────────────────────────────────────────────────────────────────────────────

/** 同步尺寸区块：显示尺寸面板，并更新选中状态 */
function syncSizeSection() {
  document.getElementById('sizeSection').style.display  = 'block';

  // 确保 state.size 与当前模式一致（防御性修复，正常流程不应产生不一致）
  if (state.sizeMode === 'pixel') {
    if (!state.size || !state.size.includes('x')) state.size = state.pixelSize;
  } else {
    if (!state.size || (!state.size.includes(':') && state.size !== 'auto')) state.size = state.ratioSize;
  }

  // 模式切换 seg：所有渠道均显示
  const modeSegEl = document.getElementById('sizeModeSeg');
  modeSegEl.style.display = '';

  document.querySelectorAll('#sizeModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sizeMode === state.sizeMode));

  document.getElementById('ratioPanel').style.display  = state.sizeMode === 'ratio' ? '' : 'none';
  document.getElementById('pixelPanel').style.display  = state.sizeMode === 'pixel' ? '' : 'none';
  if (state.sizeMode === 'ratio') {
    renderRatioPanel();
  } else {
    syncPixelPanel();
  }
  syncComposerSummary();
}

/** 渲染比例 chip 网格（innerHTML，靠父级事件代理响应点击） */
function renderRatioPanel() {
  const panel = document.getElementById('ratioPanel');
  const MAX_DIM = 22;
  panel.innerHTML =
    '<div class="size-ratio-grid">' +
    SIZE_RATIO_PRESETS.map(s => {
      const isActive = state.size === s.value;
      const isAuto   = s.value === 'auto';
      let thumbHtml;
      if (isAuto) {
        thumbHtml = `<div class="size-ratio-thumb-auto">A</div>`;
      } else {
        const { w, h } = parseAspectRatio(s.value);
        const bw = Math.round(w / Math.max(w, h) * MAX_DIM);
        const bh = Math.round(h / Math.max(w, h) * MAX_DIM);
        thumbHtml = `<div class="size-rect" style="width:${bw}px;height:${bh}px;"></div>`;
      }
      return `<button type="button" class="size-ratio-chip${isActive ? ' active' : ''}" data-ratio="${s.value}" title="${esc(s.desc)}">
        <div class="size-ratio-thumb">${thumbHtml}</div>
        <span class="size-ratio-label">${s.label}</span>
      </button>`;
    }).join('') +
    '</div>';
}

/** 同步像素面板的选中状态（tiles + 自定义输入） */
function syncPixelPanel() {
  document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el =>
    el.classList.toggle('active', el.dataset.sizePx === state.size));
  // 仅当当前是自定义尺寸时才填入输入框（预设 tile 选中后由 tile click 清空输入框）
  const isPreset = SIZE_PIXEL_PRESETS.some(p => p.value === state.size);
  const isCustomPx = state.size.includes('x') && !isPreset;
  if (isCustomPx) {
    const [w, h] = state.size.split('x');
    document.getElementById('customWidthInput').value  = w;
    document.getElementById('customHeightInput').value = h;
  } else if (isPreset) {
    // 预设被选中时清空自定义输入框，避免残留上次自定义数值
    document.getElementById('customWidthInput').value  = '';
    document.getElementById('customHeightInput').value = '';
  }
}

/** 校验自定义尺寸，返回错误文案或 null */
function validateCustomSize(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '请输入有效的宽度和高度';
  if (w < SIZE_CUSTOM_PX_MIN || w > SIZE_CUSTOM_PX_MAX)
    return `宽度须在 ${SIZE_CUSTOM_PX_MIN}–${SIZE_CUSTOM_PX_MAX} 之间（当前: ${w}）`;
  if (h < SIZE_CUSTOM_PX_MIN || h > SIZE_CUSTOM_PX_MAX)
    return `高度须在 ${SIZE_CUSTOM_PX_MIN}–${SIZE_CUSTOM_PX_MAX} 之间（当前: ${h}）`;
  if (w % 16 !== 0) return `宽度须被 16 整除（当前: ${w}）`;
  if (h % 16 !== 0) return `高度须被 16 整除（当前: ${h}）`;
  const px = w * h;
  if (px < SIZE_PIXEL_BUDGET_MIN)
    return `总像素不足（${w}×${h} = ${px.toLocaleString()}，最小 ${SIZE_PIXEL_BUDGET_MIN.toLocaleString()}）`;
  if (px > SIZE_PIXEL_BUDGET_MAX)
    return `总像素超限（${w}×${h} = ${px.toLocaleString()}，最大 ${SIZE_PIXEL_BUDGET_MAX.toLocaleString()}）`;
  return null;
}

/** 应用自定义像素尺寸（由按钮 / Enter 触发） */
function applyCustomSize() {
  const wEl  = document.getElementById('customWidthInput');
  const hEl  = document.getElementById('customHeightInput');
  const errEl = document.getElementById('customSizeError');
  const w = parseInt(wEl.value, 10);
  const h = parseInt(hEl.value, 10);
  const err = validateCustomSize(w, h);
  if (err) {
    errEl.textContent = err;
    return;
  }
  errEl.textContent = '';
  state.size = `${w}x${h}`;
  state.pixelSize = state.size;
  // 取消预设 tile 高亮
  document.querySelectorAll('#pixelPresetGrid .size-option').forEach(el => el.classList.remove('active'));
  toast(`自定义尺寸已应用：${w}×${h}`, 'success');
  syncComposerSummary();
}

function selectQuality(el) {
  document.querySelectorAll('[data-q]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  state.quality = el.dataset.q;
  syncComposerSummary();
}

function selectFormat(el) {
  document.querySelectorAll('[data-fmt]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  state.format = el.dataset.fmt;
  syncCompressionSection();
  syncComposerSummary();
}

/** 异步模式时隐藏输出格式区块 */
function syncFormatSection() {
  const el = document.getElementById('formatSection');
  if (el) el.style.display = state.asyncMode === 'async' ? 'none' : '';
}

/** 根据当前格式和模式显示/隐藏压缩滑块（仅同步 + JPEG/WEBP 需要） */
function syncCompressionSection() {
  const el = document.getElementById('compressionSection');
  if (!el) return;
  if (state.asyncMode === 'async') {
    el.style.display = 'none';
    return;
  }
  const fmt = state.format.toUpperCase();
  el.style.display = (fmt === 'JPEG' || fmt === 'WEBP') ? '' : 'none';
}

/** 当前接口显示实验性功能区块（当前暂时隐藏） */
function syncExperimentalSection() {
  const el = document.getElementById('cndExperimentalSection');
  if (el) el.style.display = 'none';
}

function adjustCount(d) {
  const cap = maxCount();
  const next = state.count + d;
  if (next < 1 || next > cap) return;
  state.count = next;
  syncCountStepperUi();
  syncComposerSummary();
}

function updateCharCount() {
  const text = getPromptValue();
  document.getElementById('charCount').textContent  = text.length;
  document.getElementById('tokenCount').textContent = Math.ceil(text.length / 2.5);
}

function clearPrompt() {
  syncPromptValue('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  const tid = setTimeout(() => el.remove(), duration);
  // auto-remove on click too
  el.addEventListener('click', () => { clearTimeout(tid); el.remove(); }, { once: true });
}

let _syncGenToastWrap = null;

/** 同步生成进行中：底部居中 danger 风格提示（与顶部 Toast 样式一致） */
function showSyncGenerationToast() {
  if (_syncGenToastWrap?.isConnected) return;
  const wrap = document.createElement('div');
  wrap.className = 'sync-gen-toast-wrap';
  wrap.setAttribute('role', 'status');
  const el = document.createElement('div');
  el.className = 'toast error sync-gen-toast';
  el.textContent = '正在同步生成图像，请勿关闭、刷新或离开本页';
  wrap.appendChild(el);
  document.body.appendChild(wrap);
  _syncGenToastWrap = wrap;
}

function hideSyncGenerationToast() {
  _syncGenToastWrap?.remove();
  _syncGenToastWrap = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Feed helpers
// ─────────────────────────────────────────────────────────────────────────────
function scrollToLatest(instant = false) {
  const body = document.getElementById('canvasBody');
  if (!body) return;
  body.scrollTo({ top: body.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function updateToolbarBadge() {
  const feed = document.getElementById('chatFeed');
  const count = feed ? feed.querySelectorAll('.image-card').length : 0;
  const badge = document.getElementById('toolbarBadge');
  if (count > 0) {
    badge.textContent = `${count} 张`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function historyPanelCardHtml(rec, src) {
  return `
    <div class="history-panel-card" data-rec-id="${escapeAttr(rec.id)}">
      <div class="history-panel-thumb">${src ? `<img src="${escapeAttr(src)}" alt="" loading="lazy" />` : ''}</div>
      <div class="history-panel-meta">
        <div class="history-panel-prompt" title="${escapeAttr(rec.prompt || '')}">${esc(rec.prompt || '')}</div>
        <div class="history-panel-tags">
          <span>${esc(rec.size || '-')}</span>
          <span>${esc(rec.quality || '-')}</span>
          <span>${esc(rec.format || '-')}</span>
        </div>
      </div>
    </div>`;
}

async function renderHistoryPanel() {
  const body = document.getElementById('historyPanelBody');
  if (!body) return;
  resetHistoryPanelObjectUrls();
  const records = await db.getRecentRecordsByImageLimit(6).catch(() => []);
  const flat = Array.isArray(records) ? records.filter(rec => rec?.images?.length) : [];
  if (!flat.length) {
    body.innerHTML = `<div class="history-panel-empty">暂无历史记录</div>`;
    return;
  }
  const rows = await Promise.all(flat.slice(0, 6).map(async rec => {
    const img = rec.images?.[0];
    const row = await materializeStoredImage(img, rec.format);
    if (row?.objectUrl) _historyPanelObjectUrls.push(row.objectUrl);
    return { rec, src: row?.src || '' };
  }));
  body.innerHTML = rows.map(item => historyPanelCardHtml(item.rec, item.src)).join('');
  body.querySelectorAll('.history-panel-card').forEach(card => {
    const recId = card.dataset.recId;
    card.addEventListener('click', () => void showImageDetail(recId, 0));
  });
}

/** 友好时间：今天/昨天/前天/2026年5月8日 周五，附 HH:mm */
function friendlyTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msgDay    = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays  = Math.round((todayStart - msgDay) / 86400000);
  const hhmm      = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const weekdays  = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  if (diffDays === 0)  return `今天 ${hhmm}`;
  if (diffDays === 1)  return `昨天 ${hhmm}`;
  if (diffDays === 2)  return `前天 ${hhmm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]} ${hhmm}`;
}

function buildParamsBubble(prompt, params) {
  const { size, quality, format, channel, count } = params;
  const chDef   = CHANNEL[channel] || CHANNEL.cnd;
  const chClass = 'ch-cnd';

  const tags = [
    size      && `<span class="chat-tag">${esc(size).toLocaleUpperCase()}</span>`,
    quality   && `<span class="chat-tag">${esc(quality).toLocaleUpperCase()}</span>`,
    format    && `<span class="chat-tag">${esc(format).toLocaleUpperCase()}</span>`,
    count > 1 && `<span class="chat-tag">×${count}</span>`,
    `<span class="chat-tag ${chClass}">${esc(chDef.name)}</span>`,
  ].filter(Boolean).join('');

  return `<div class="chat-bubble-params">
    ${prompt ? `<div class="chat-prompt">${esc(prompt)}</div>` : ''}
    <div class="chat-tags">${tags}</div>
  </div>`;
}

function createChatRow(prompt, params) {
  const feed = document.getElementById('chatFeed');

  // Time divider above each row
  if (params.ts) {
    const divider = document.createElement('div');
    divider.className = 'chat-divider';
    divider.innerHTML = `<span class="chat-divider-text">${friendlyTime(params.ts)}</span>`;
    feed.appendChild(divider);
  }

  const row = document.createElement('div');
  row.className = 'chat-row';

  const userHead = document.createElement('div');
  userHead.className = 'chat-row-head chat-row-user';
  userHead.innerHTML = `<div class="chat-avatar av-u"><img src="/assets/images/头像.jpg" alt="User"></div>${buildParamsBubble(prompt, params)}`;

  const aiHead = document.createElement('div');
  aiHead.className = 'chat-row-head chat-row-ai';
  aiHead.innerHTML = `<div class="chat-avatar av-a">AI</div>`;

  const colImages = document.createElement('div');
  colImages.className = 'chat-col-images';

  row.appendChild(userHead);
  row.appendChild(aiHead);
  row.appendChild(colImages);
  feed.appendChild(row);

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('clearBtn').style.display   = 'inline-block';

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton (sync loading placeholder)
// ─────────────────────────────────────────────────────────────────────────────
function showSkeletonInRow(row, n, size) {
  _activeSyncRow = row;
  const col = row.querySelector('.chat-col-images');
  const { w, h } = parseAspectRatio(size);
  const ratio = h / w;
  const cw = cardWidth(size);
  col.innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton-card" style="width:${cw}px;flex-shrink:0;">
      <div class="skeleton-img" style="padding-bottom:${(ratio * 100).toFixed(1)}%;position:relative;">
        <div class="skeleton-generating-label">正在生成中…</div>
      </div>
      <div class="skeleton-footer">
        <div class="skeleton-line" style="width:70px;height:12px;"></div>
        <div class="skeleton-line" style="width:40px;height:12px;"></div>
      </div>
    </div>
  `).join('');
}

function hideSkeletonInRow(row) {
  if (!row) return;
  const col = row.querySelector('.chat-col-images');
  if (col) col.querySelectorAll('.skeleton-card').forEach(c => c.remove());
  if (_activeSyncRow === row) _activeSyncRow = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightbox (Viewer.js)
// ─────────────────────────────────────────────────────────────────────────────
let _viewer = null;

function ensureViewerPagerButtons(viewer, total) {
  if (!viewer?.viewer || total <= 1) return;
  const host = viewer.viewer;
  host.querySelectorAll('.viewer-nav-overlay').forEach(node => node.remove());

  const makeButton = (direction, label, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `viewer-nav-overlay viewer-nav-${direction}`;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = direction === 'prev' ? '&#8249;' : '&#8250;';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    host.appendChild(btn);
  };

  makeButton('prev', '上一张', () => viewer.prev());
  makeButton('next', '下一张', () => viewer.next());
}

function updateViewerPagerButtons(viewer) {
  if (!viewer?.viewer) return;
  const prevBtn = viewer.viewer.querySelector('.viewer-nav-prev');
  const nextBtn = viewer.viewer.querySelector('.viewer-nav-next');
  if (!prevBtn || !nextBtn) return;
  prevBtn.disabled = viewer.index <= 0;
  nextBtn.disabled = viewer.index >= viewer.length - 1;
}

function openLightbox(srcs, initialIndex = 0, options = {}) {
  if (_viewer) { _viewer.destroy(); _viewer = null; }

  const srcList = Array.isArray(srcs) ? srcs : [srcs];
  const idx = Math.max(0, Math.min(initialIndex, srcList.length - 1));
  const showPagerArrows = options.showPagerArrows !== false;

  const container = document.createElement('ul');
  container.style.display = 'none';
  srcList.forEach(s => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = s;
    li.appendChild(img);
    container.appendChild(li);
  });
  document.body.appendChild(container);

  _viewer = new Viewer(container, {
    navbar:           srcList.length > 1,
    title:            false,
    initialViewIndex: idx,
    toolbar: {
      zoomIn:      4,
      zoomOut:     4,
      oneToOne:    4,
      reset:       4,
      rotateLeft:  4,
      rotateRight: 4,
    },
    shown() {
      if (showPagerArrows && srcList.length > 1) {
        ensureViewerPagerButtons(_viewer, srcList.length);
        updateViewerPagerButtons(_viewer);
      }
    },
    viewed() {
      updateViewerPagerButtons(_viewer);
    },
    hidden() {
      _viewer.destroy();
      _viewer = null;
      container.remove();
    },
  });
  _viewer.show();
}

function closeLightbox() {
  _viewer?.hide();
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────
function imageMimeFromFormat(fmt) {
  switch (String(fmt || '').toUpperCase()) {
    case 'JPEG': return 'image/jpeg';
    case 'WEBP': return 'image/webp';
    default:     return 'image/png';
  }
}

function fileExtFromMime(mime, fallbackFmt = 'PNG') {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/png') return 'png';
  return String(fallbackFmt || 'png').toLowerCase();
}

function revokeObjectUrl(url) {
  if (!url || !String(url).startsWith('blob:')) return;
  try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
}

function revokeCardObjectUrl(card) {
  const url = card?.dataset?.objectUrl;
  if (url) revokeObjectUrl(url);
}

function revokeObjectUrlsIn(root) {
  if (!root) return;
  root.querySelectorAll('[data-object-url]').forEach(el => revokeObjectUrl(el.dataset.objectUrl));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

async function readBlobImageDimensions(blob) {
  if (!blob) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch (_) {
      // Fall back to HTMLImageElement below.
    }
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (value) => {
      revokeObjectUrl(url);
      resolve(value);
    };
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

async function materializeStoredImage(image, fmt) {
  if (!image) return null;
  if (!image.imageId) return null;
  const asset = await db.getImageAssetById(image.imageId).catch(() => null);
  if (!asset?.blob) return null;
  const src = URL.createObjectURL(asset.blob);
  return {
    src,
    ref: {
      imageId: image.imageId,
      mime: image.mime || asset.mime || imageMimeFromFormat(fmt),
      width: image.width || asset.width || null,
      height: image.height || asset.height || null,
    },
    width: image.width || asset.width || null,
    height: image.height || asset.height || null,
    objectUrl: src,
  };
}

async function materializeStoredImages(images, fmt) {
  const rows = await Promise.all((images || []).map(img => materializeStoredImage(img, fmt)));
  return rows.filter(Boolean);
}

async function readReferenceImageBlob(refImage) {
  const sourceUrl = String(refImage?.url || '').trim();
  if (!sourceUrl) {
    throw new Error('Reference image is missing a readable source');
  }
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Failed to read reference image: HTTP ${res.status}`);
  }
  return await res.blob();
}

async function buildReferenceEditFormData({ prompt, size, quality, count, refImages, providerId }) {
  const form = new FormData();
  form.append('providerId', String(providerId || '').trim());
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('response_format', 'b64_json');
  form.append('n', String(Math.max(1, Number(count) || 1)));

  for (let i = 0; i < refImages.length; i++) {
    const refImage = refImages[i];
    const blob = await readReferenceImageBlob(refImage);
    const name = String(refImage?.name || `reference-${i + 1}.png`).trim() || `reference-${i + 1}.png`;
    form.append('image[]', blob, name);
  }

  return form;
}

function collectUpstreamActualParams(source) {
  const actual = {};
  if (typeof source?.size === 'string' && source.size) actual.size = source.size;
  if (typeof source?.quality === 'string' && source.quality) actual.quality = source.quality;
  if (typeof source?.output_format === 'string' && source.output_format) actual.format = source.output_format.toUpperCase();
  if (typeof source?.n === 'number' && source.n > 0) actual.count = source.n;

  return Object.keys(actual).length ? actual : null;
}

function collectRevisedPrompts(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => (typeof item?.revised_prompt === 'string' ? item.revised_prompt.trim() : ''))
    .filter(Boolean);
}

async function materializeRecordForDetail(rec) {
  resetDetailModalObjectUrls();
  const materialized = await materializeStoredImages(rec.images, rec.format);
  materialized.forEach(item => {
    if (item.objectUrl) _detailModalObjectUrls.push(item.objectUrl);
  });
  return {
    ...rec,
    images: materialized.map(item => ({
      url: item.src,
      ref: item.ref,
      width: item.width,
      height: item.height,
    })),
  };
}

async function downloadImageRef(imageRef, fmt, idx) {
  if (!imageRef) return;
  if (!imageRef.imageId) return;
  const asset = await db.getImageAssetById(imageRef.imageId).catch(() => null);
  if (!asset?.blob) {
    toast('本地图片不存在或已损坏', 'error');
    return;
  }
  const ext = fileExtFromMime(asset.mime || imageRef.mime, fmt);
  const filename = `gpt-image-${Date.now()}-${idx + 1}.${ext}`;
  if (state.downloadDir) {
    const fd = new FormData();
    fd.append('file', asset.blob, filename);
    fd.append('targetDir', state.downloadDir);
    fd.append('filename', filename);
    try {
      const res = await fetch('/api/download-image', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok !== true) {
        toast(json?.error || '保存图片失败', 'error');
        return;
      }
      toast(`已保存到 ${json.path || state.downloadDir}`, 'success');
    } catch (error) {
      toast(error.message || '保存图片失败', 'error');
    }
    return;
  }
  const url = URL.createObjectURL(asset.blob);
  const a  = document.createElement('a');
  a.href   = url;
  a.download = filename;
  a.click();
  setTimeout(() => revokeObjectUrl(url), 1000);
}

async function copyImageToClipboard(imageRef, fmt) {
  if (!imageRef?.imageId) return;
  const asset = await db.getImageAssetById(imageRef.imageId).catch(() => null);
  if (!asset?.blob) {
    toast('本地图片不存在或已损坏', 'error');
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast('当前浏览器不支持图片复制', 'error');
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [asset.mime || imageMimeFromFormat(fmt)]: asset.blob })]);
    toast('图片已复制到剪贴板', 'success');
  } catch (error) {
    toast(error.message || '复制失败', 'error');
  }
}

async function toggleCollection(recordId, imageIndex, imageRef, fmt) {
  if (!recordId || !imageRef?.imageId) return;
  const key = collectionKey(recordId, imageIndex);
  const existing = _collectionMap.get(key);
  if (existing) {
    const res = await fetch(`/api/collection/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok !== true) {
      toast(json?.error || '取消收藏失败', 'error');
      return;
    }
    await refreshCollections();
    toast('已取消收藏', 'success');
    return;
  }

  const rec = await getRecord(recordId);
  const asset = await db.getImageAssetById(imageRef.imageId).catch(() => null);
  if (!rec || !asset?.blob) {
    toast('收藏所需图片数据不存在', 'error');
    return;
  }
  const ext = fileExtFromMime(asset.mime || imageRef.mime, fmt);
  const fd = new FormData();
  fd.append('file', asset.blob, `favorite.${ext}`);
  fd.append('recordId', recordId);
  fd.append('imageIndex', String(imageIndex));
  fd.append('prompt', rec.prompt || '');
  fd.append('size', rec.size || '');
  fd.append('quality', rec.quality || '');
  fd.append('format', rec.format || fmt || '');
  fd.append('savedAt', String(Date.now()));
  const res = await fetch('/api/collection', { method: 'POST', body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok !== true) {
    toast(json?.error || '收藏失败', 'error');
    return;
  }
  await refreshCollections();
  toast(json?.duplicated ? '已在收藏中' : '已收藏到本地 collection 文件夹', 'success');
}

async function rerunRecord(recId) {
  if (!recId) return;
  const rec = await getRecord(recId);
  if (!rec) return;
  const asyncMode = rec.asyncMode || (rec.requestMode === 'async' ? 'async' : 'sync');
  const prevMode = state.asyncMode;
  const prevProviderId = state.selectedProviderId;
  const prevCount = state.count;
  const prevSize = state.size;
  const prevQuality = state.quality;
  const prevFormat = state.format;
  const prevCompression = state.compression;
  try {
    state.asyncMode = asyncMode;
    state.selectedProviderId = rec.providerId || state.selectedProviderId;
    state.size = rec.size || state.size;
    state.quality = rec.quality || state.quality;
    state.format = rec.format || state.format;
    state.count = Math.min(maxCount(), Math.max(1, rec.count || 1));
    state.compression = rec.compression ?? state.compression;
    syncCountStepperUi();
    syncModeButtons();
    syncFormatSection();
    syncCompressionSection();
    syncComposerSummary();
    await generateWithPrompt(rec.prompt || '', state.compression);
  } finally {
    state.asyncMode = prevMode;
    state.selectedProviderId = prevProviderId;
    state.count = prevCount;
    state.size = prevSize;
    state.quality = prevQuality;
    state.format = prevFormat;
    state.compression = prevCompression;
    syncCountStepperUi();
    syncModeButtons();
    syncFormatSection();
    syncCompressionSection();
    syncComposerSummary();
  }
}

async function persistBlobImages(recordId, blobs, fallbackMime) {
  const storedImages = [];
  const preparedImages = [];
  try {
    for (let i = 0; i < blobs.length; i++) {
      const rawBlob = blobs[i];
      const mime = rawBlob?.type || fallbackMime || 'application/octet-stream';
      const blob = rawBlob instanceof Blob ? rawBlob : new Blob([rawBlob], { type: mime });
      const imageId = genId();
      const dimensions = await readBlobImageDimensions(blob);
      await db.putImageAsset({
        id: imageId,
        recordId,
        mime,
        blob,
        width: dimensions?.width || null,
        height: dimensions?.height || null,
        ts: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      storedImages.push({
        imageId,
        mime,
        width: dimensions?.width || null,
        height: dimensions?.height || null,
      });
      preparedImages.push({
        src: objectUrl,
        ref: {
          imageId,
          mime,
          width: dimensions?.width || null,
          height: dimensions?.height || null,
        },
        objectUrl,
      });
    }
  } catch (err) {
    await deleteStoredImageRefs(storedImages);
    preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
    throw err;
  }
  markCacheSizeDirty();
  return { storedImages, preparedImages };
}

async function deleteStoredImageRefs(images) {
  const list = Array.isArray(images) ? images : [];
  for (const image of list) {
    if (image?.imageId) {
      await db.deleteImageAssetById(image.imageId).catch(() => {});
    }
  }
  if (list.some(image => image?.imageId)) markCacheSizeDirty();
}

async function deleteRecordWithAssets(recId) {
  const rec = await getRecord(recId);
  if (!rec) return;
  await deleteStoredImageRefs(rec.images);
  await deleteRecord(recId);
  if (Array.isArray(_historyRecords)) {
    _historyRecords = _historyRecords.filter(row => row.id !== recId);
  }
  const feed = document.getElementById('chatFeed');
  feed.querySelectorAll(`.image-card[data-rec-id="${recId}"]`).forEach(card => {
    revokeCardObjectUrl(card);
    const row = card.closest('.chat-row');
    card.remove();
    if (row && !row.querySelector('.chat-col-images')?.children.length) removeRowWithDivider(row);
  });
  if (!feed.children.length) {
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
  }
  updateToolbarBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Records（IndexedDB `records` 表）
// ─────────────────────────────────────────────────────────────────────────────
async function getRecords() {
  return await db.getRecordsSorted();
}

async function getRecord(recId) {
  if (!recId) return null;
  return await db.getRecordById(recId);
}

function markCacheSizeDirty() {
  _cacheSizeDirty = true;
}

async function saveRecord(rec) {
  if (!db.hasDb()) {
    toast('IndexedDB 不可用，记录未保存', 'error');
    return false;
  }
  try {
    await db.putRecord(rec);
    markCacheSizeDirty();
    void renderHistoryPanel();
    return true;
  } catch (e) {
    const q = e && e.name === 'QuotaExceededError';
    toast(q ? '存储空间不足，记录未保存' : (e.message || '记录保存失败'), 'error');
    return false;
  }
}

async function deleteRecord(id) {
  if (!db.hasDb()) return;
  await db.deleteRecordById(id);
  markCacheSizeDirty();
  void renderHistoryPanel();
}

function clearAllRecords() {
  if (!confirm('确定清除生成记录与待恢复任务？API Key、Token 统计等设置仍会保留。此操作不可恢复。')) return;
  void (async () => {
    stopAllPendingPolls();
    try {
      if (db.hasDb()) {
        await db.clearRecords();
        await db.clearPendingTasks();
        await db.clearQueueTasks();
        await db.clearImageAssets();
      }
    } catch (_) { /* ignore */ }
    markCacheSizeDirty();
    resetHistoryModalObjectUrls();
    const feed = document.getElementById('chatFeed');
    revokeObjectUrlsIn(feed);
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
    void renderHistoryPanel();
    syncTaskQueue([]);
    await updateCacheSize();
    updateCumulativeTokens();
    toast('生成记录与待恢复任务已清除', 'info');
    closeSettings();
  })();
}

async function updateCacheSize() {
  const el = document.getElementById('cacheSize');
  if (!el) return;
  if (!_cacheSizeDirty) {
    el.textContent = _cacheSizeText;
    return;
  }
  try {
    if (!db.hasDb()) {
      el.textContent = '—';
      _cacheSizeText = '—';
      _cacheSizeDirty = false;
      return;
    }
    el.textContent = '计算中…';
    await nextPaint();
    const bytes = await db.estimateDbBytes();
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / 1048576).toFixed(2);
    _cacheSizeText = bytes > 102400 ? mb + ' MB' : kb + ' KB';
    _cacheSizeDirty = false;
    el.textContent = _cacheSizeText;
  } catch {
    el.textContent = '—';
  }
}

function getUsageStats() {
  const u = state.usageStats;
  return { input: u.input, output: u.output, total: u.total };
}

async function saveUsageStats(s) {
  state.usageStats = {
    input:  Number(s.input)  || 0,
    output: Number(s.output) || 0,
    total:  Number(s.total)  || 0,
  };
  if (!db.hasDb()) return;
  try {
    await db.kvSet(KV_USAGE_STATS, JSON.stringify(state.usageStats));
  } catch {
    toast('Token 统计写入失败', 'error');
  }
}

/** 将接口返回的 usage 累加到独立缓存（清除生成记录不会动此项） */
async function accumulateUsageStats(usage) {
  if (!usage) return;
  const has = usage.input_tokens != null || usage.output_tokens != null || usage.total_tokens != null;
  if (!has) return;
  const cur = getUsageStats();
  cur.input  += Number(usage.input_tokens)  || 0;
  cur.output += Number(usage.output_tokens) || 0;
  cur.total  += Number(usage.total_tokens)  || 0;
  await saveUsageStats(cur);
  updateCumulativeTokens();
}

function updateCumulativeTokens() {
  const s = getUsageStats();
  document.getElementById('cumulativeIn').textContent    = s.input;
  document.getElementById('cumulativeOut').textContent   = s.output;
  document.getElementById('cumulativeTotal').textContent = s.total;
}

function setEmptyState(empty) {
  document.getElementById('emptyState').style.display    = empty ? 'flex' : 'none';
  document.getElementById('clearBtn').style.display      = empty ? 'none' : 'inline-block';
  if (empty) {
    document.getElementById('toolbarTitle').textContent  = '等待生成…';
    document.getElementById('toolbarBadge').style.display = 'none';
    document.getElementById('chatFeed').innerHTML = '';
  }
}

async function loadRecordsToCanvas() {
  const records = await db.getRecentRecordsByImageLimit(CANVAS_INITIAL_IMAGE_LIMIT);
  if (!records.length) return;

  // getRecentRecordsByImageLimit 返回从新到旧；翻转为从旧到新 append，保持时间顺序
  const ordered = records.slice().reverse();

  // Group records with the same batchId into one chat row
  const batches = [];
  const batchIdMap = new Map(); // batchId → index in batches[]
  for (const rec of ordered) {
    if (!rec.images?.length) continue;
    if (rec.batchId && batchIdMap.has(rec.batchId)) {
      batches[batchIdMap.get(rec.batchId)].push(rec);
    } else {
      const idx = batches.length;
      batches.push([rec]);
      if (rec.batchId) batchIdMap.set(rec.batchId, idx);
    }
  }

  for (const batch of batches) {
    const first = batch[0];
    const totalImages = batch.reduce((sum, r) => sum + (r.images?.length || 0), 0);
    const row = createChatRow(first.prompt, {
      size:    first.size,
      quality: first.quality,
      format:  first.format,
      channel: first.channel || 'cnd',
      count:   totalImages,
      ts:      first.ts,
    });
    row.dataset.recId = first.id;
    for (const rec of batch) {
      await renderStoredRecordImages(rec, row);
    }
  }

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('clearBtn').style.display   = 'inline-block';
  updateToolbarBadge();
  void renderHistoryPanel();

  const rendered = document.getElementById('chatFeed').querySelectorAll('.image-card').length;
  document.getElementById('toolbarTitle').textContent =
    rendered >= CANVAS_INITIAL_IMAGE_LIMIT
      ? `最近记录（仅显示最近 ${rendered} 张）`
      : '图像生成工作台';
  updateCumulativeTokens();

  requestAnimationFrame(() => scrollToLatest(true));
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Card Rendering
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Render prepared images into the images column of a chat row.
 */
function renderImagesInRow(row, displayImages, fmt, size, recId, channel, usage) {
  const col = row.querySelector('.chat-col-images');
  if (!col) return;

  row.dataset.recId = recId;

  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const frag = document.createDocumentFragment();

  displayImages.forEach((item, i) => {
    const card = buildImageCard(item.src, item.ref, fmt, size, sw, sh, cw, recId, channel, i, item.objectUrl || '');
    frag.appendChild(card);
  });
  col.appendChild(frag);

  if (usage) {
    document.getElementById('tokIn').textContent    = usage.input_tokens  ?? '—';
    document.getElementById('tokOut').textContent   = usage.output_tokens ?? '—';
    document.getElementById('tokTotal').textContent = usage.total_tokens  ?? '—';
    document.getElementById('tokenInfo').style.display = 'block';
  }

  updateToolbarBadge();
}

async function renderStoredRecordImages(rec, row) {
  const displayImages = await materializeStoredImages(rec.images, rec.format);
  if (!displayImages.length) return;
  renderImagesInRow(row, displayImages, rec.format, rec.size, rec.id, rec.channel || 'cnd', null);
}

function buildImageCard(src, imageRef, fmt, size, sw, sh, cw, recId, channel, idx, objectUrl = '') {
  const card = document.createElement('div');
  card.className      = 'image-card';
  card.style.width    = cw + 'px';
  card.dataset.recId  = recId  || '';
  card.dataset.imgIdx = idx;
  if (objectUrl) card.dataset.objectUrl = objectUrl;

  // Channel tag label & class
  const favActive = isCollected(recId, idx);

  card.innerHTML = `
    <button class="card-del-btn" title="删除">✕</button>
    <img src="${escapeAttr(src)}" alt="Generated ${idx + 1}" loading="lazy"
      style="${size === 'auto' ? 'width:100%;display:block;height:auto;' : `aspect-ratio:${sw}/${sh};width:100%;display:block;object-fit:cover;`}" />
    <div class="image-card-footer">
      <span class="image-meta" title="${size.toLocaleUpperCase()} · ${fmt}">${size.toLocaleUpperCase()} · ${fmt}</span>
      <div class="image-actions">
        <button class="icon-btn image-download-btn" title="下载">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button class="icon-btn image-fav-btn${favActive ? ' active' : ''}" title="${favActive ? '取消收藏' : '收藏'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
        </button>
        <button class="icon-btn image-copy-btn" title="复制">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        </button>
        <button class="icon-btn image-refresh-btn" title="刷新">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15A9 9 0 1 1 23 10"/>
          </svg>
        </button>
      </div>
    </div>`;

  // Event listeners on card elements
  card.querySelector('.card-del-btn').addEventListener('click', e => {
    e.stopPropagation();
    void deleteImageCard(card);
  });
  card.querySelector('img').addEventListener('click', () => {
    void showImageDetail(card.dataset.recId, idx);
  });
  card.querySelector('.image-meta').addEventListener('click', e => {
    e.stopPropagation();
    void showImageDetail(card.dataset.recId, idx);
  });
  card.querySelector('.image-download-btn').addEventListener('click', e => {
    e.stopPropagation();
    void downloadImageRef(imageRef, fmt, idx);
  });
  card.querySelector('.image-copy-btn').addEventListener('click', e => {
    e.stopPropagation();
    void copyImageToClipboard(imageRef, fmt);
  });
  card.querySelector('.image-fav-btn').addEventListener('click', e => {
    e.stopPropagation();
    void toggleCollection(recId, idx, imageRef, fmt);
  });
  card.querySelector('.image-refresh-btn').addEventListener('click', e => {
    e.stopPropagation();
    void rerunRecord(card.dataset.recId);
  });

  return card;
}

async function deleteImageCard(card) {
  if (!confirm('确定删除此图片？')) return;
  const recId  = card.dataset.recId;
  const imgIdx = parseInt(card.dataset.imgIdx, 10);

  if (recId) {
    const rec = await getRecord(recId);
    if (rec && rec.images) {
      const [removed] = rec.images.splice(imgIdx, 1);
      if (removed?.imageId) {
        await db.deleteImageAssetById(removed.imageId).catch(() => {});
        markCacheSizeDirty();
      }
      if (!rec.images.length) {
        await deleteRecord(recId);
      } else {
        await db.putRecord(rec);
        markCacheSizeDirty();
      }
    }
  }

  revokeCardObjectUrl(card);
  const row = card.closest('.chat-row');
  card.remove();
  if (row) {
    const col = row.querySelector('.chat-col-images');
    if (col && !col.children.length) removeRowWithDivider(row);
  }

  const feed = document.getElementById('chatFeed');
  if (!feed || !feed.querySelector('.image-card, .image-card-pending')) {
    setEmptyState(true);
    document.getElementById('tokenInfo').style.display = 'none';
  }
  updateToolbarBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove a .chat-row and its preceding .chat-divider sibling (if any). */
function removeRowWithDivider(row) {
  if (!row) return;
  const prev = row.previousElementSibling;
  if (prev?.classList.contains('chat-divider')) prev.remove();
  row.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending Card (async task placeholder)
// ─────────────────────────────────────────────────────────────────────────────
function createPendingCard(cardId, taskId, size, channel) {
  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const chName = CHANNEL[channel]?.name || channel;

  const card = document.createElement('div');
  card.className        = 'image-card-pending';
  card.style.width      = cw + 'px';
  card.dataset.cardId   = cardId;
  card.dataset.taskId   = taskId;

  card.innerHTML = `
    <div class="pending-img-area" style="aspect-ratio:${sw}/${sh};">
      <div class="pending-spinner"></div>
      <div class="pending-label" id="pl-${cardId}">排队中</div>
      <div class="pending-progress" id="pp-${cardId}"></div>
    </div>
    <div class="pending-track"><div class="pending-bar" id="pb-${cardId}" style="width:0%"></div></div>
    <div class="pending-footer">
      <span class="pending-meta">${size.toLocaleUpperCase()} · ${chName}</span>
      <button class="pending-cancel-btn" data-task-id="${taskId}">暂停</button>
    </div>`;

  card.querySelector('.pending-cancel-btn').onclick = e => {
    e.stopPropagation();
    pausePendingTask(taskId);
  };

  return card;
}

function updatePendingStatus(cardId, label, progressText = '', progressPct = null) {
  const labelEl = document.getElementById(`pl-${cardId}`);
  const progressEl = document.getElementById(`pp-${cardId}`);
  const barEl = document.getElementById(`pb-${cardId}`);
  if (labelEl && label) labelEl.textContent = label;
  if (progressEl) progressEl.textContent = progressText || '';
  if (barEl && progressPct != null) barEl.style.width = progressPct + '%';
}

function updatePendingFromTaskState(cardId, taskState, progress) {
  const stateText = taskState === 'running'
    ? '进行中'
    : taskState === 'queued' || taskState === 'pending'
      ? '排队中'
      : '处理中';
  const progressText = taskState === 'running' && progress != null ? `${progress}%` : '';
  updatePendingStatus(cardId, stateText, progressText);
}

function registerPendingTask(taskId, cardId, attempts = 0) {
  state.pendingPolls.set(taskId, {
    attempts,
    timerId: null,
    cardId,
    finalizeState: null,
  });
}

function pollDelayForTask(taskId) {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = (hash * 31 + taskId.charCodeAt(i)) & 0xffff;
  }
  return POLL_INTERVAL + (hash % POLL_JITTER_MAX);
}

function removeQueuedFinalizeTask(taskId) {
  const idx = _asyncFinalizeQueue.findIndex(job => job.taskId === taskId);
  if (idx >= 0) _asyncFinalizeQueue.splice(idx, 1);
}

function queueAsyncFinalizeTask(taskId, prompt, compression, data, usage) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll || poll.finalizeState) return;
  poll.finalizeState = 'queued';
  updatePendingStatus(poll.cardId, '结果整理中', '');
  _asyncFinalizeQueue.push({ taskId, prompt, compression, data, usage });
  void pumpAsyncFinalizeQueue();
}

async function pumpAsyncFinalizeQueue() {
  if (_asyncFinalizeRunning) return;
  _asyncFinalizeRunning = true;
  try {
    while (_asyncFinalizeQueue.length) {
      const job = _asyncFinalizeQueue.shift();
      if (!job) continue;
      const poll = state.pendingPolls.get(job.taskId);
      if (!poll) continue;
      poll.finalizeState = 'running';
      updatePendingStatus(poll.cardId, '结果整理中', '');
      await nextPaint();
      try {
        await finishAsyncTask(job.taskId, poll, job.data, job.prompt, job.compression, job.usage);
      } catch (err) {
        failAsyncTask(job.taskId, poll, err.message || '结果整理失败');
      }
      await nextPaint();
    }
  } finally {
    _asyncFinalizeRunning = false;
  }
}

/**
 * Replace a pending card with actual image card(s), keeping them in the same chat row.
 */
function resolvePendingCard(cardId, taskId, displayImages, fmt, size, recId, channel) {
  const feed = document.getElementById('chatFeed');
  const pendingCard = feed.querySelector(`[data-card-id="${cardId}"]`);
  const row = pendingCard?.closest('.chat-row');
  if (!row) return;

  const col = row.querySelector('.chat-col-images');
  const cw = cardWidth(size);
  const { w: sw, h: sh } = parseAspectRatio(size);
  const frag = document.createDocumentFragment();

  displayImages.forEach((item, i) => {
    const card = buildImageCard(item.src, item.ref, fmt, size, sw, sh, cw, recId, channel, i, item.objectUrl || '');
    card.style.animation = 'cardAppear 0.22s ease forwards';
    frag.appendChild(card);
  });

  if (pendingCard) {
    col.insertBefore(frag, pendingCard.nextSibling);
    pendingCard.remove();
  } else {
    col.appendChild(frag);
  }
  updateToolbarBadge();
}

function pausePendingTask(taskId) {
  const poll = state.pendingPolls.get(taskId);
  if (poll) {
    if (poll.finalizeState === 'running') {
      toast('结果整理中，当前无法暂停，请稍候', 'info');
      return;
    }
    clearTimeout(poll.timerId);
    removeQueuedFinalizeTask(taskId);
    state.pendingPolls.delete(taskId);
  }

  // Mark as paused in DB so page refresh won't auto-resume it
  db.getTaskById(taskId).then(task => {
    if (task) db.saveTask({ ...task, paused: true }).catch(() => {});
  }).catch(() => {});

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-task-id="${taskId}"]`);
  if (card) setPendingCardPaused(card, taskId);

  updateToolbarBadge();
  toast('已暂停，刷新页面或点击继续可恢复', 'info');
}

function setPendingCardPaused(card, taskId) {
  const cardId = card.dataset.cardId;
  card.classList.add('is-paused');
  const labelEl = document.getElementById(`pl-${cardId}`);
  if (labelEl) labelEl.textContent = '已暂停';
  const progressEl = document.getElementById(`pp-${cardId}`);
  if (progressEl) progressEl.textContent = '';
  const barEl = document.getElementById(`pb-${cardId}`);
  if (barEl) barEl.style.width = '0%';
  const btn = card.querySelector('.pending-cancel-btn');
  if (btn) {
    btn.textContent = '继续';
    btn.onclick = e => { e.stopPropagation(); resumePausedTask(taskId); };
  }
}

async function resumePausedTask(taskId) {
  const stored = await db.getTaskById(taskId).catch(() => null);
  if (!stored) {
    toast('任务记录已丢失，无法恢复', 'error');
    return;
  }

  // Clear paused flag in DB
  db.saveTask({ ...stored, paused: false }).catch(() => {});

  const { cardId, prompt, compression } = stored;
  registerPendingTask(taskId, cardId, 0);

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-task-id="${taskId}"]`);
  if (card) {
    card.classList.remove('is-paused');
    updatePendingStatus(cardId, '排队中', '', 0);
    const btn = card.querySelector('.pending-cancel-btn');
    if (btn) {
      btn.textContent = '暂停';
      btn.onclick = e => { e.stopPropagation(); pausePendingTask(taskId); };
    }
  }

  schedulePoll(taskId, prompt, compression, stored.providerId);
  updateToolbarBadge();
  toast('已继续轮询', 'info');
}

/** 停止所有异步轮询（不清 DB；用于整页清理前） */
function stopAllPendingPolls() {
  for (const poll of state.pendingPolls.values()) {
    if (poll.timerId) clearTimeout(poll.timerId);
  }
  _asyncFinalizeQueue.length = 0;
  state.pendingPolls.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate — Entry Point
// ─────────────────────────────────────────────────────────────────────────────
async function generate() {
  if (state.loading) return;

  await generateWithPrompt(
    getPromptValue().trim(),
    parseInt(document.getElementById('compression').value, 10),
  );
}

async function generateWithPrompt(prompt, compression = state.compression) {
  if (!getProviderApiKey()) {
    toast('请先在设置中配置 API Key', 'error');
    openSettings();
    return;
  }
  if (!prompt) {
    toast('请输入描述词', 'error');
    return;
  }
  if (!ensureProxyRuntimeReady()) return;

  syncPromptValue(prompt);

  if (state.asyncMode === 'async') {
    const controller = initTaskQueueController();
    const task = buildQueueTaskFromCurrentState(prompt, compression);
    await controller.enqueueTask(task);
    toast('任务已加入队列', 'info');
  } else {
    await generateSync(prompt, compression);
  }
}

function setGenerateButtonsBusy(busy, label) {
  for (const id of ['genBtn', 'sidebarGenBtn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = busy;
    btn.innerHTML = busy ? `<div class="spinner"></div> ${label}` : `${PLAY_ICON} 开始生成`;
  }
}

function ensureProxyRuntimeReady() {
  const endpoint = String(CHANNEL.cnd?.endpoint || '');
  if (!endpoint.startsWith('/api/')) return true;
  if (location.protocol === 'file:' || location.port === '63342') {
    toast('当前是静态预览环境，无法调用本地 Node 接口。请先运行 npm start 再访问页面。', 'error', 8000);
    return false;
  }
  return true;
}

/** 将比例字符串转换为接口所需像素尺寸 */
function resolveSizeForChannel(size, channelId) {
  if (channelId !== 'cnd') return size;
  if (!size || size === 'auto' || size.includes('x')) return size || 'auto';
  return CND_RATIO_TO_PX[size] || '1024x1024';
}

function snapshotRefImages(refImages) {
  return (Array.isArray(refImages) ? refImages : []).map(img => ({ ...img }));
}

function buildQueueTaskFromCurrentState(prompt, compression) {
  return createQueueTaskSnapshot({
    id: genId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    prompt,
    providerId: getSelectedProvider()?.id || state.defaultProviderId,
    params: {
      size: state.size,
      quality: state.quality,
      format: state.format,
      count: state.count,
      compression,
      moderation: state.moderation,
      streamEnabled: state.streamEnabled,
    },
    refImages: snapshotRefImages(state.refImages),
  });
}

async function executeGenerationTask(task, options = {}) {
  const provider = getProviderById(state.providers, task.providerId) || getSelectedProvider();
  const apiKey = getProviderApiKey(provider?.id);
  const { requestInit, body, providerId, hasRefs } = await buildQueueTaskRequestInit(task, {
    endpoint: CHANNEL.cnd.endpoint,
    apiKey,
    resolveSizeForChannel,
    buildReferenceEditFormData,
  });
  const startedAt = Date.now();
  const refImages = snapshotRefImages(task.refImages || []);

  const res = await fetch(CHANNEL.cnd.endpoint, requestInit);
  let json;
  if (body.stream && res.headers.get('content-type')?.includes('text/event-stream')) {
    json = await parseStreamResponse(res);
  } else {
    json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }

  const recId = genId();
  const mime = imageMimeFromFormat(task.params?.format || state.format);
  const blobs = [];
  for (const item of json.data || []) {
    if (!item?.b64_json) continue;
    blobs.push(base64ToBlob(item.b64_json, mime));
    if ((json.data || []).length > 1) await nextPaint();
  }
  const { storedImages, preparedImages } = await persistBlobImages(recId, blobs, mime);
  const rec = {
    id: recId,
    ts: Date.now(),
    channel: state.channel,
    asyncMode: 'async',
    providerId,
    prompt: task.prompt,
    size: task.params?.size || state.size,
    quality: task.params?.quality || state.quality,
    format: task.params?.format || state.format,
    compression: task.params?.compression ?? options.compression ?? 100,
    count: task.params?.count || 1,
    images: storedImages,
    usage: json.usage || null,
    ...createDetailRecordPayload({
      prompt: task.prompt,
      size: task.params?.size || state.size,
      quality: task.params?.quality || state.quality,
      format: task.params?.format || state.format,
      count: task.params?.count || 1,
      durationMs: Date.now() - startedAt,
      result: {
        actualParams: collectUpstreamActualParams(json),
        revisedPrompts: collectRevisedPrompts(json.data),
      },
    }),
  };
  const saved = await saveRecord(rec);
  if (!saved) {
    await deleteStoredImageRefs(storedImages);
    preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
    throw new Error('本地记录保存失败');
  }

  return {
    record: rec,
    preparedImages,
    usage: json.usage || null,
    data: json.data || [],
  };
}

function renderCompletedQueueTask(result) {
  const rec = result.record;
  const feed = document.getElementById('chatFeed');
  const row = createChatRow(rec.prompt, {
    size: rec.size,
    quality: rec.quality,
    format: rec.format,
    channel: rec.channel || 'cnd',
    count: rec.count || 1,
    ts: rec.ts,
  });
  feed.appendChild(row);
  renderImagesInRow(row, result.preparedImages, rec.format, rec.size, rec.id, rec.channel || 'cnd', result.usage);
  void accumulateUsageStats(result.usage);
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('toolbarTitle').textContent = '生成完成';
  scrollToLatest();
}

function initTaskQueueController() {
  if (_taskQueueController) return _taskQueueController;
  _taskQueueController = createTaskQueueController({
    loadTasks: loadQueueTasks,
    persistTask: persistQueueTask,
    deleteTask: deleteQueueTaskPersisted,
    onTaskChange: async (tasks) => {
      syncTaskQueue(tasks);
    },
    onTaskDone: async (_task, result) => {
      renderCompletedQueueTask(result);
    },
    executeTask: async (task) => executeGenerationTask(task),
  });
  return _taskQueueController;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Generation
// ─────────────────────────────────────────────────────────────────────────────
async function generateSync(prompt, compression) {
  const ch  = CHANNEL.cnd;
  const provider = getSelectedProvider();
  const apiKey = getProviderApiKey(provider?.id);
  const startedAt = Date.now();

  state.loading = true;
  showSyncGenerationToast();
  setGenerateButtonsBusy(true, '生成中…');
  document.getElementById('toolbarTitle').textContent = '正在生成，请稍候…';

  // 先创建对话行，放骨架屏
  const chatRow = createChatRow(prompt, {
    size:    state.size,
    quality: state.quality,
    format:  state.format,
    channel: state.channel,
    count:   state.count,
    ts:      startedAt,
  });
  showSkeletonInRow(chatRow, state.count, state.size);
  scrollToLatest();

  try {
    const hasRefs = hasReferenceImages(state.refImages);
    const body = attachRequestMetadata(buildSyncPayload({
      prompt,
      size: resolveSizeForChannel(state.size, state.channel),
      quality: state.quality,
      count: state.count,
      refImages: state.refImages,
    }), {
      providerId: provider?.id || state.defaultProviderId,
    });
    // 实验性参数
    if (state.moderation) body.moderation = 'low';
    if (state.streamEnabled) {
      body.stream        = true;
      body.partial_images = 2;
    }

    const requestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: null,
    };
    if (hasRefs) {
      requestInit.body = await buildReferenceEditFormData({
        prompt,
        size: resolveSizeForChannel(state.size, state.channel),
        quality: body.quality,
        count: body.n,
        refImages: state.refImages,
        providerId: provider?.id || state.defaultProviderId,
      });
    } else {
      requestInit.headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(body);
    }

    const res  = await fetch(ch.endpoint, requestInit);

    let json;
    if (state.streamEnabled && (res.headers.get('content-type') || '').includes('text/event-stream')) {
      json = await parseStreamResponse(res);
    } else {
      json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    }

    hideSkeletonInRow(chatRow);

    const recId = genId();
    const mime = imageMimeFromFormat(state.format);
    const blobs = [];
    for (const item of json.data || []) {
      if (!item?.b64_json) continue;
      blobs.push(base64ToBlob(item.b64_json, mime));
      if ((json.data || []).length > 1) await nextPaint();
    }
    const { storedImages, preparedImages } = await persistBlobImages(recId, blobs, mime);
    const rec   = {
      id:          recId,
      ts:          Date.now(),
      channel:     state.channel,
      asyncMode:   state.asyncMode,
      providerId:  provider?.id || state.defaultProviderId,
      prompt,
      size:        state.size,
      quality:     state.quality,
      format:      state.format,
      compression,
      count:       state.count,
      images:      storedImages,
      usage:       json.usage || null,
      ...createDetailRecordPayload({
        prompt,
        size: state.size,
        quality: state.quality,
        format: state.format,
        count: state.count,
        durationMs: Date.now() - startedAt,
        result: {
          actualParams: collectUpstreamActualParams(json),
          revisedPrompts: collectRevisedPrompts(json.data),
        },
      }),
    };
    const saved = await saveRecord(rec);
    if (!saved) {
      await deleteStoredImageRefs(storedImages);
      preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
      throw new Error('本地记录保存失败');
    }

    renderImagesInRow(chatRow, preparedImages, state.format, state.size, recId, state.channel, json.usage || null);
    await accumulateUsageStats(json.usage);

    document.getElementById('emptyState').style.display    = 'none';
    document.getElementById('toolbarTitle').textContent     = '生成完成';
    toast(`成功生成 ${json.data.length} 张图像`, 'success');
    scrollToLatest();

  } catch (err) {
    hideSkeletonInRow(chatRow);
    // 如果出错且行内没有任何内容，移除这个空行
    const col = chatRow.querySelector('.chat-col-images');
    if (col && !col.children.length) chatRow.remove();
    const feed = document.getElementById('chatFeed');
    if (!feed.children.length) setEmptyState(true);
    document.getElementById('toolbarTitle').textContent = '生成失败';
    toast(err.message || '请求失败，请检查 API Key 和网络', 'error');
    console.error('[generateSync]', err);
  } finally {
    state.loading = false;
    hideSyncGenerationToast();
    setGenerateButtonsBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream response parser (流式 SSE 解析，用于 stream + partial_images)
// ─────────────────────────────────────────────────────────────────────────────
async function parseStreamResponse(res) {
  if (!res.ok) {
    let errJson = {};
    try { errJson = await res.json(); } catch (_) {}
    throw new Error(errJson?.error?.message || `HTTP ${res.status}`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (_) { continue; }
      if (ev.type === 'partial_image' && (ev.partial_image_b64 || ev.b64)) {
        updateSkeletonWithPartial(ev.index ?? ev.partial_image_index ?? 0, ev.partial_image_b64 || ev.b64);
      } else if (ev.type === 'response.done' && ev.response) {
        finalResponse = ev.response;
      }
    }
  }
  if (!finalResponse) throw new Error('流式响应未返回最终结果');
  return finalResponse;
}

/** 将 SSE 局部预览图渲染到对应骨架屏格子 */
function updateSkeletonWithPartial(index, b64) {
  if (!_activeSyncRow) return;
  const col  = _activeSyncRow.querySelector('.chat-col-images');
  if (!col) return;
  const cards = col.querySelectorAll('.skeleton-card');
  const card  = cards[index];
  if (!card) return;
  const imgArea = card.querySelector('.skeleton-img');
  if (!imgArea) return;
  const mime = imageMimeFromFormat(state.format);
  imgArea.style.backgroundImage    = `url(data:${mime};base64,${b64})`;
  imgArea.style.backgroundSize     = 'cover';
  imgArea.style.backgroundPosition = 'center';
  imgArea.classList.add('has-partial');
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Generation
// ─────────────────────────────────────────────────────────────────────────────
async function generateAsync(prompt, compression) {
  const ch  = CHANNEL.cnd;
  const provider = getSelectedProvider();
  const apiKey = getProviderApiKey(provider?.id);
  setGenerateButtonsBusy(true, '提交中…');

  let chatRow = null;
  let col = null;

  try {
    const batchN = Math.min(maxCount(), Math.max(1, state.count));
    const batchId = genId();
    const submittedAt = Date.now();

    // Create one shared chat row for all tasks in this batch
    chatRow = createChatRow(prompt, {
      size:    state.size,
      quality: state.quality,
      format:  state.format,
      channel: state.channel,
      count:   batchN,
      ts:      submittedAt,
    });
    col = chatRow.querySelector('.chat-col-images');
    scrollToLatest();

    for (let i = 0; i < batchN; i++) {
      const body = attachRequestMetadata(buildAsyncPayload({
        prompt,
        size: resolveSizeForChannel(state.size, state.channel),
        quality: state.quality,
        refImages: state.refImages,
      }), {
        providerId: provider?.id || state.defaultProviderId,
      });

      const res  = await fetch(ch.asyncEndpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

      const taskId = json.id;
      if (!taskId) throw new Error('未返回任务 ID');

      const cardId = genId();
      registerPendingTask(taskId, cardId, 0);

      const card = createPendingCard(cardId, taskId, state.size, state.channel);
      col.appendChild(card);
      updatePendingStatus(cardId, '排队中', '');

      await db.saveTask({
        taskId,
        cardId,
        batchId,
        channel: state.channel,
        asyncMode: state.asyncMode,
        prompt,
        compression,
        params: {
          size: state.size,
          quality: state.quality,
          format: state.format,
          count: 1,
        },
        providerId: provider?.id || state.defaultProviderId,
        submittedAt,
        ts: submittedAt,
      });
      markCacheSizeDirty();

      schedulePoll(taskId, prompt, compression, provider?.id || state.defaultProviderId);
    }

    updateToolbarBadge();
    toast(
      batchN > 1
        ? `已提交 ${batchN} 个异步任务，后台轮询中…`
        : '任务已提交，后台轮询中…',
      'info',
    );
    document.getElementById('toolbarTitle').textContent = '异步任务处理中…';
  } catch (err) {
    if (chatRow && !col?.children.length) removeRowWithDivider(chatRow);
    toast(err.message || '提交失败，请检查 API Key 和网络', 'error');
    console.error('[generateAsync]', err);
  } finally {
    setGenerateButtonsBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────────────────────
function schedulePoll(taskId, prompt, compression, providerId = state.selectedProviderId) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll) return;

  const tid = setTimeout(() => doPoll(taskId, prompt, compression, providerId), pollDelayForTask(taskId));
  poll.timerId = tid;
}

async function doPoll(taskId, prompt, compression, providerId = state.selectedProviderId) {
  const poll = state.pendingPolls.get(taskId);
  if (!poll) return;   // task was cancelled

  poll.attempts++;
  const ch = CHANNEL.cnd;
  const pollUrl = buildPollRequestUrl(`${ch.asyncPollBase}${taskId}`, { providerId });

  try {
    const res  = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${getProviderApiKey(providerId)}` },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

    // 异步响应格式: { status: "queued"|"in_progress"|"completed"|"failed"|"unknown", metadata: { url } }
    const status = json.status || 'unknown';

    if (status === 'queued') {
      updatePendingStatus(poll.cardId, '排队中', '');
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression, providerId);

    } else if (status === 'in_progress') {
      const pct = Math.min(88, Math.round(Math.sqrt(poll.attempts / POLL_MAX) * 110));
      updatePendingStatus(poll.cardId, '进行中', pct + '%', pct);
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression, providerId);

    } else if (status === 'completed') {
      const imageUrl = json.metadata?.url;
      if (!imageUrl) throw new Error('任务完成但未返回图片地址');
      // 规范化为 finishAsyncTask 期望的 data 格式
      const data = { images: [{ url: imageUrl }] };
      queueAsyncFinalizeTask(taskId, prompt, compression, data, json.usage || null);

    } else if (status === 'failed') {
      throw new Error('任务处理失败');

    } else {
      // unknown — keep polling
      updatePendingStatus(poll.cardId, '处理中', '');
      if (poll.attempts >= POLL_MAX) throw new Error('任务超时，请稍后刷新页面重试');
      schedulePoll(taskId, prompt, compression, providerId);
    }

  } catch (err) {
    failAsyncTask(taskId, poll, err.message);
  }
}

async function persistAsyncImages(rawImages, cardId, recordId, fallbackMime) {
  const list = Array.isArray(rawImages) ? rawImages : [];
  const blobs = [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    updatePendingStatus(cardId, '结果整理中', list.length > 1 ? `${i + 1}/${list.length}` : '');
    await nextPaint();
    try {
      const r = await fetch(img.url);
      if (!r.ok) continue;
      const blob = await r.blob();
      blobs.push(blob);
    } catch {
      // ignore and continue; if all fail, caller will surface an error
    }
  }
  if (!blobs.length) return { storedImages: [], preparedImages: [] };
  return await persistBlobImages(recordId, blobs, fallbackMime);
}

async function finishAsyncTask(taskId, poll, data, prompt, compression, usage) {
  const stored = await db.getTaskById(taskId).catch(() => null);
  const params = stored?.params || { size: state.size, format: state.format, quality: state.quality, count: 1 };

  const recId = genId();
  const mime = imageMimeFromFormat(params.format);
  const { storedImages, preparedImages } = await persistAsyncImages(data.images || [], poll.cardId, recId, mime);

  if (!storedImages.length) {
    throw new Error('无法加载生成的图像');
  }

  updatePendingStatus(poll.cardId, '写入本地中', '');
  await nextPaint();

  const rec   = {
      id:          recId,
      ts:          Date.now(),
      channel:     'cnd',
      asyncMode:   stored?.asyncMode || 'async',
      providerId:  stored?.providerId || state.defaultProviderId,
      prompt:      stored?.prompt || prompt,
      size:        params.size,
      quality:     params.quality,
      format:      params.format,
      compression: stored?.compression ?? compression,
      count:       storedImages.length,
      images:      storedImages,
      usage:       usage || null,
      batchId:     stored?.batchId || null,
      requestedParams: stored?.requestedParams || {
        size: params.size,
        quality: params.quality,
        format: params.format,
        count: params.count || storedImages.length,
      },
      actualParams: stored?.actualParams || null,
      durationMs: stored?.submittedAt ? Date.now() - stored.submittedAt : null,
      revisedPrompt: stored?.revisedPrompt || '',
    };
  const saved = await saveRecord(rec);
  if (!saved) {
    await deleteStoredImageRefs(storedImages);
    preparedImages.forEach(item => revokeObjectUrl(item.objectUrl));
    throw new Error('本地记录保存失败');
  }

  resolvePendingCard(poll.cardId, taskId, preparedImages, params.format, params.size, recId, 'cnd');
  await accumulateUsageStats(usage);

  // Clean up
  state.pendingPolls.delete(taskId);
  await db.deleteTask(taskId).catch(() => {});
  markCacheSizeDirty();

  scrollToLatest();
  document.getElementById('toolbarTitle').textContent = '生成完成';
  toast(`异步任务完成，已生成 ${storedImages.length} 张图像`, 'success');
}

function failAsyncTask(taskId, poll, message) {
  clearTimeout(poll.timerId);
  removeQueuedFinalizeTask(taskId);
  state.pendingPolls.delete(taskId);
  db.deleteTask(taskId).catch(() => {});
  markCacheSizeDirty();

  const feed = document.getElementById('chatFeed');
  const card = feed.querySelector(`[data-card-id="${poll.cardId}"]`);
  if (card) {
    const row = card.closest('.chat-row');
    card.remove();
    if (row) {
      const col = row.querySelector('.chat-col-images');
      if (col && !col.children.length) removeRowWithDivider(row);
    }
  }

  if (!feed.querySelector('.image-card, .image-card-pending')) setEmptyState(true);
  updateToolbarBadge();

  document.getElementById('toolbarTitle').textContent = '异步任务失败';
  toast(`任务失败：${message}`, 'error');
  console.error('[doPoll]', message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page-reload Recovery
// ─────────────────────────────────────────────────────────────────────────────
async function resumePendingTasks() {
  const tasks = await db.getAllTasks().catch(() => []);
  if (!tasks.length) return;

  toast(`发现 ${tasks.length} 个待恢复的异步任务，正在恢复…`, 'info', 4000);

  // Group by batchId; tasks without batchId (legacy) each get their own group
  const groups = new Map();
  for (const task of tasks) {
    const key = task.batchId || task.taskId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  for (const groupTasks of groups.values()) {
    const first = groupTasks[0];
    const { channel, prompt, params } = first;

    const chatRow = createChatRow(prompt || '', {
      size:    params?.size    || '1024x1536',
      quality: params?.quality || 'high',
      format:  params?.format  || 'PNG',
      channel: channel || 'cnd',
      count:   groupTasks.length,
      ts:      first.submittedAt ?? first.ts,
    });
    const col = chatRow.querySelector('.chat-col-images');

    for (const task of groupTasks) {
      const { taskId, cardId, compression, params: tp } = task;
      const card = createPendingCard(cardId, taskId, tp?.size || '1024x1536', task.channel || 'cnd');
      col.appendChild(card);
      if (task.paused) {
        setPendingCardPaused(card, taskId);
      } else {
        registerPendingTask(taskId, cardId, 0);
        updatePendingStatus(cardId, '排队中', '');
        setTimeout(() => doPoll(taskId, task.prompt, compression, task.providerId), 1500);
      }
    }
  }

  updateToolbarBadge();
  requestAnimationFrame(() => scrollToLatest(true));
}

// ─────────────────────────────────────────────────────────────────────────────
// History gallery grid (2:3 frame, pagination)
// ─────────────────────────────────────────────────────────────────────────────
function flattenHistoryItems(records) {
  const flat = [];
  for (const rec of records) {
    (rec.images || []).forEach((_, imgIdx) => flat.push({ rec, imgIdx }));
  }
  return flat;
}

function filterHistoryRecords(records, query) {
  return filterHistoryRecordsByPrompt(records, query);
}

function historyGalleryCardHtml(item, src) {
  const { rec, imgIdx } = item;
  if (!rec.images?.[imgIdx] || !src) return '';
  return `
    <div class="modal-gallery-card image-card modal-gallery-card-compact history-gallery-card" data-rec-id="${escapeAttr(rec.id)}" data-img-idx="${imgIdx}">
      <button type="button" class="card-del-btn" title="删除整条记录">✕</button>
      <div class="modal-card-media-23">
        <img src="${escapeAttr(src)}" alt="" loading="lazy" />
      </div>
      <div class="modal-gallery-card-footer history-gallery-card-footer">
        <div class="modal-gallery-title" title="${escapeAttr(rec.prompt)}">${esc(rec.prompt)}</div>
        <div class="modal-gallery-sub">${esc(rec.size)} · ${esc(rec.quality)} · ${esc(rec.format)}</div>
        <div class="modal-gallery-actions">
          <button type="button" class="btn-ghost modal-gallery-action-btn hist-download">下载</button>
          <button type="button" class="btn-ghost modal-gallery-action-btn hist-use-config">使用配置</button>
          <button type="button" class="btn-ghost modal-gallery-action-btn hist-add-ref">添加参考图</button>
        </div>
      </div>
    </div>`;
}

function bindHistoryGalleryCards(body, records, srcMap) {
  const recordMap = new Map(records.map(rec => [rec.id, rec]));

  body.querySelectorAll('.modal-gallery-card').forEach(card => {
    const recId = card.dataset.recId;
    const imgIdx = parseInt(card.dataset.imgIdx, 10);
    const rec = recordMap.get(recId);
    if (!rec || !rec.images?.[imgIdx]) return;

    card.querySelector('.card-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('确定删除整条生成记录？')) return;
      void (async () => {
        await deleteRecordWithAssets(recId);
        const left = await getRecords();
        if (!left.length) {
          closeHistoryModal();
          return;
        }
        await renderHistoryGallery(_historyGalleryPage);
      })();
    });

    card.querySelector('.modal-card-media-23 img').addEventListener('click', e => {
      e.stopPropagation();
      void showImageDetail(recId, imgIdx);
    });

    card.querySelector('.hist-download').addEventListener('click', e => {
      e.stopPropagation();
      const imageRef = rec.images?.[imgIdx];
      if (!imageRef) return;
      void downloadImageRef(imageRef, rec.format, imgIdx);
    });

    card.querySelector('.hist-use-config').addEventListener('click', e => {
      e.stopPropagation();
      void useConfig(recId).then(() => closeHistoryModal());
    });

    card.querySelector('.hist-add-ref').addEventListener('click', e => {
      e.stopPropagation();
      void addHistoryImageAsReference(recId, imgIdx);
    });
  });
}

async function renderHistoryGallery(page, recordsInput = null) {
  const records = recordsInput || _historyRecords || await getRecords();
  const body = document.getElementById('historyModalBody');
  if (!records.length) {
    closeHistoryModal();
    return;
  }
  const filteredRecords = filterHistoryRecords(records, _historySearchQuery);
  const flat = flattenHistoryItems(filteredRecords);
  if (!flat.length) {
    body.innerHTML = `<div class="history-panel-empty">暂无匹配记录</div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(flat.length / MODAL_GALLERY_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  _historyGalleryPage = p;
  const start = (p - 1) * MODAL_GALLERY_PAGE_SIZE;
  let slice = flat.slice(start, start + MODAL_GALLERY_PAGE_SIZE);
  if (!slice.length && p > 1) {
    return await renderHistoryGallery(p - 1);
  }
  resetHistoryModalObjectUrls();
  const srcMap = new Map();
  const sliceSources = await Promise.all(slice.map(async item => {
    const img = item.rec.images?.[item.imgIdx];
    const row = await materializeStoredImage(img, item.rec.format);
    if (row?.objectUrl) _historyModalObjectUrls.push(row.objectUrl);
    const key = `${item.rec.id}:${item.imgIdx}`;
    if (row?.src) srcMap.set(key, row.src);
    return row?.src || '';
  }));

  const pager = totalPages > 1 ? `
    <div class="modal-gallery-pager">
      <button type="button" class="btn-ghost hist-gallery-prev">上一页</button>
      <span class="modal-gallery-pageinfo">${p} / ${totalPages}</span>
      <button type="button" class="btn-ghost hist-gallery-next">下一页</button>
    </div>` : '';

  body.innerHTML =
    '<div class="modal-gallery-grid">' +
    slice.map((item, idx) => historyGalleryCardHtml(item, sliceSources[idx])).join('') +
    '</div>' +
    pager;

  if (totalPages > 1) {
    const prev = body.querySelector('.hist-gallery-prev');
    const next = body.querySelector('.hist-gallery-next');
    prev.disabled = p <= 1;
    next.disabled = p >= totalPages;
    prev.addEventListener('click', () => void renderHistoryGallery(p - 1));
    next.addEventListener('click', () => void renderHistoryGallery(p + 1));
  }

  bindHistoryGalleryCards(body, filteredRecords, srcMap);
}

function bindHistorySearchInput() {
  const input = document.getElementById('historySearchInput');
  if (!input || input.dataset.bound === '1') return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => {
    _historySearchQuery = input.value || '';
    void renderHistoryGallery(1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Polish Modal
// ─────────────────────────────────────────────────────────────────────────────
function openPolishModal() {
  const editor = document.getElementById('polishEditor');
  editor.innerText = getPromptValue() || '';
  document.getElementById('polishModal').classList.add('open');
  syncPolishButtons();
  setTimeout(() => editor.focus(), 60);
}

function closePolishModal() {
  document.getElementById('polishModal').classList.remove('open');
}

function syncPolishButtons() {
  const quickBtns = [
    document.getElementById('quickPolishPromptBtn'),
    document.getElementById('quickPolishPromptBtnBottom'),
  ].filter(Boolean);
  const runBtn = document.getElementById('polishRunBtn');
  const disabled = getPolishDisabledState({
    deepseekConfigured: state.deepseekConfigured,
    loading: _polishLoading,
  });
  quickBtns.forEach(quickBtn => {
    quickBtn.disabled = disabled;
    quickBtn.querySelector('span').textContent = getPolishButtonLabel(_polishLoading);
  });
  if (runBtn) {
    runBtn.disabled = disabled;
    runBtn.textContent = getPolishButtonLabel(_polishLoading);
  }
}

async function runPromptPolish() {
  if (_polishLoading) return;
  if (!state.deepseekConfigured) {
    toast('当前服务端未配置 Prompt 润色', 'info');
    return;
  }
  const editor = document.getElementById('polishEditor');
  const body = buildPolishRequest(editor.innerText || '');
  if (!body.text) {
    toast('请输入 Prompt', 'info');
    return;
  }
  _polishLoading = true;
  syncPolishButtons();
  try {
    const res = await fetch('/api/polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json?.ok !== true) throw new Error(json?.error || `HTTP ${res.status}`);
    editor.innerText = readPolishResponseText(json);
    toast('Prompt 已润色', 'success');
  } catch (error) {
    toast(error.message || '润色失败', 'error');
  } finally {
    _polishLoading = false;
    syncPolishButtons();
  }
}

async function quickPolishPrompt() {
  openPolishModal();
  await runPromptPolish();
}

function applyPolishedPrompt() {
  const editor = document.getElementById('polishEditor');
  const text = normalizePolishText(editor.innerText || '');
  syncPromptValue(text);
  closePolishModal();
  toast('已应用润色文本', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// History Modal
// ─────────────────────────────────────────────────────────────────────────────
async function openHistoryModal() {
  const records = await getRecords();
  if (!records.length) { toast('暂无历史记录', 'info'); return; }
  if (!flattenHistoryItems(records).length) { toast('暂无历史记录', 'info'); return; }

  setHistoryRecords(records);
  _historyGalleryPage = 1;
  _historySearchQuery = '';
  await renderHistoryGallery(1, records);
  document.getElementById('historyModal').classList.add('open');
  bindHistorySearchInput();
  const input = document.getElementById('historySearchInput');
  if (input) input.value = '';
}

function closeHistoryModal() {
  setHistoryRecords(null);
  resetHistoryModalObjectUrls();
  _historySearchQuery = '';
  const input = document.getElementById('historySearchInput');
  if (input) input.value = '';
  document.getElementById('historyModal').classList.remove('open');
}

async function addHistoryImageAsReference(recId, imageIndex) {
  const addState = getReferenceImageAddState({
    currentCount: state.refImages.length,
    asyncMode: state.asyncMode,
    asyncDisabled: state.asyncDisabled,
  });
  if (!addState.ok) {
    toast(addState.reason, 'info');
    return;
  }

  const rec = await getRecord(recId);
  const imageRef = rec?.images?.[imageIndex];
  if (!imageRef?.imageId) {
    toast('历史图片不可用', 'error');
    return;
  }

  const asset = await db.getImageAssetById(imageRef.imageId).catch(() => null);
  if (!asset?.blob) {
    toast('本地图片不存在或已损坏', 'error');
    return;
  }

  const dataUrl = await blobToDataUrl(asset.blob);
  if (!dataUrl.startsWith('data:image/')) {
    toast('历史图片格式无效', 'error');
    return;
  }

  state.refImages.push(makeHistoryReferenceImage({
    recordId: rec.id,
    index: imageIndex,
    dataUrl,
  }));
  renderRefImages();
  toast('已添加为参考图', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail Modal
// ─────────────────────────────────────────────────────────────────────────────
async function showImageDetail(recId, imageIndex = 0) {
  if (!recId) return;
  const rec = await getRecord(recId);
  if (!rec) return;

  const detailRecord = await materializeRecordForDetail(rec);
  _detailRecordCache = detailRecord;
  _detailState.open({
    recordId: detailRecord.id,
    imageIndex,
    imageCount: Array.isArray(detailRecord.images) ? detailRecord.images.length : 1,
  });
  renderDetailModal({
    modalBody: document.getElementById('detailModalBody'),
    record: detailRecord,
    imageIndex: _detailState.getSnapshot().imageIndex,
  });
  document.getElementById('detailModal').classList.add('open');
}

function closeDetailModal() {
  _detailState.close();
  resetDetailModalObjectUrls();
  _detailRecordCache = null;
  document.getElementById('detailModal').classList.remove('open');
  document.getElementById('detailModalBody').innerHTML = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Config
// ─────────────────────────────────────────────────────────────────────────────
async function useConfig(recId) {
  if (!recId) return;
  const rec = await getRecord(recId);
  if (!rec) return;

  syncPromptValue(rec.prompt);

  applySize(rec.size);

  const qualEl = document.querySelector(`[data-q="${rec.quality}"]`);
  if (qualEl) selectQuality(qualEl);

  const fmtEl = document.querySelector(`[data-fmt="${rec.format}"]`);
  if (fmtEl) selectFormat(fmtEl);

  document.getElementById('compression').value      = rec.compression ?? 100;
  document.getElementById('compressionVal').textContent = rec.compression ?? 100;
  state.compression = rec.compression ?? 100;

  state.count = Math.min(maxCount(), Math.max(1, rec.count || 1));
  syncCountStepperUi();
  syncComposerSummary();

  toast('配置已应用', 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear Canvas
// ─────────────────────────────────────────────────────────────────────────────
function clearCanvas() {
  const feed = document.getElementById('chatFeed');
  revokeObjectUrlsIn(feed);
  setEmptyState(true);
  document.getElementById('tokenInfo').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Images
// ─────────────────────────────────────────────────────────────────────────────
function removeRefImage(idx) {
  state.refImages.splice(idx, 1);
  renderRefImages();
}

function clearRefImages() {
  state.refImages = [];
  renderRefImages();
}

function renderRefImages() {
  const el = document.getElementById('refImages');
  if (!state.refImages.length) {
    el.style.display = 'none';
    el.innerHTML     = '';
    syncComposerSummary();
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="ref-images-label">
      <span>参考图 (${state.refImages.length})</span>
      <button class="ref-images-clear" id="refClearAll">全部删除</button>
    </div>
    ${state.refImages.map((img, i) => `
      <div class="ref-img-item" data-idx="${i}">
        <img src="${escapeAttr(img.url)}" alt="${esc(img.name)}" title="${esc(img.name)}" />
        <button class="ref-img-del" title="移除">✕</button>
      </div>`).join('')}`;

  document.getElementById('refClearAll').addEventListener('click', () => {
    if (confirm('确定清除所有参考图？')) clearRefImages();
  });

  el.querySelectorAll('.ref-img-item').forEach(item => {
    const i = parseInt(item.dataset.idx);
    item.querySelector('img').addEventListener('click', () =>
      openLightbox(state.refImages[i].url));
    item.querySelector('.ref-img-del').addEventListener('click', e => {
      e.stopPropagation();
      removeRefImage(i);
    });
  });
  syncComposerSummary();
}


