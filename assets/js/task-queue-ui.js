import { esc, escapeAttr } from './utils.js';

const STATUS_LABEL = {
  running: '执行中',
  queued: '等待中',
  done: '已完成',
  failed: '失败',
};

let activeMenu = null;
let activeCloseHandler = null;

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function summarizePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '未命名任务';
  return text.length > 36 ? `${text.slice(0, 36)}...` : text;
}

function closeTaskQueueMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (activeCloseHandler) {
    document.removeEventListener('click', activeCloseHandler, true);
    window.removeEventListener('scroll', activeCloseHandler, true);
    window.removeEventListener('resize', activeCloseHandler, true);
    document.removeEventListener('keydown', activeCloseHandler, true);
    activeCloseHandler = null;
  }
}

function openTaskQueueMenu({ x, y, taskId, onDeleteTask }) {
  closeTaskQueueMenu();
  const menu = document.createElement('div');
  menu.className = 'task-queue-context-menu';
  menu.innerHTML = `
    <button type="button" class="task-queue-context-menu-item" data-action="delete">删除任务</button>
  `;
  document.body.appendChild(menu);
  activeMenu = menu;

  const width = 144;
  const height = 44;
  const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const cleanup = () => closeTaskQueueMenu();
  activeCloseHandler = (event) => {
    if (event.type === 'click' && menu.contains(event.target)) return;
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    cleanup();
  };
  document.addEventListener('click', activeCloseHandler, true);
  window.addEventListener('scroll', activeCloseHandler, true);
  window.addEventListener('resize', activeCloseHandler, true);
  document.addEventListener('keydown', activeCloseHandler, true);

  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    cleanup();
    await onDeleteTask(taskId);
  });
}

export function renderTaskQueueHtml(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) {
    return '<div class="task-queue-empty">暂无任务</div>';
  }

  return list.map(task => {
    const status = STATUS_LABEL[task.status] || '处理中';
    const prompt = summarizePrompt(task.prompt);
    const deletable = task.status !== 'running';
    const error = task.status === 'failed' && task.error
      ? `<div class="task-queue-item-error" title="${escapeAttr(task.error)}">${esc(task.error)}</div>`
      : '';
    return `
      <div class="task-queue-item task-queue-${escapeAttr(task.status || 'queued')}" data-task-id="${escapeAttr(task.id)}" data-task-status="${escapeAttr(task.status || 'queued')}" data-deletable="${deletable}">
        <div class="task-queue-item-head">
          <span class="task-queue-status">${status}</span>
          <span class="task-queue-time">${formatTime(task.createdAt)}</span>
        </div>
        <div class="task-queue-item-prompt" title="${escapeAttr(task.prompt || '')}">${esc(prompt)}</div>
        ${error}
      </div>
    `;
  }).join('');
}

export function renderTaskQueueInto(container, tasks, options = {}) {
  if (!container) return;
  closeTaskQueueMenu();
  container.innerHTML = renderTaskQueueHtml(tasks);

  const onDeleteTask = typeof options.onDeleteTask === 'function' ? options.onDeleteTask : null;
  if (!onDeleteTask) return;

  container.querySelectorAll('.task-queue-item[data-deletable="true"]').forEach(node => {
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const taskId = String(node.dataset.taskId || '').trim();
      if (!taskId) return;
      openTaskQueueMenu({
        x: event.clientX,
        y: event.clientY,
        taskId,
        onDeleteTask,
      });
    });
  });

  container.querySelectorAll('.task-queue-item[data-deletable="false"]').forEach(node => {
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });
}
