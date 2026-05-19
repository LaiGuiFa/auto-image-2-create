function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sortTasks(tasks) {
  return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) => {
    const left = Number(a?.createdAt) || 0;
    const right = Number(b?.createdAt) || 0;
    return left - right;
  });
}

export function createQueueTaskSnapshot(draft) {
  const now = Date.now();
  return {
    id: String(draft?.id || ''),
    createdAt: Number(draft?.createdAt) || now,
    updatedAt: Number(draft?.updatedAt) || now,
    status: String(draft?.status || 'queued'),
    prompt: String(draft?.prompt || ''),
    providerId: String(draft?.providerId || ''),
    params: cloneValue(draft?.params || {}),
    refImages: cloneValue(draft?.refImages || []),
    resultRecordId: String(draft?.resultRecordId || ''),
    error: String(draft?.error || ''),
  };
}

export function createTaskQueueController(options = {}) {
  const tasks = [];
  let running = false;
  let loopPromise = null;

  const loadTasks = options.loadTasks || (async () => []);
  const persistTask = options.persistTask || (async () => {});
  const deleteTask = options.deleteTask || (async () => {});
  const onTaskChange = options.onTaskChange || (async () => {});
  const onTaskDone = options.onTaskDone || (async () => {});
  const executeTask = options.executeTask || options.fetchGeneration || (async () => ({ ok: true }));

  function snapshot() {
    return sortTasks(tasks);
  }

  function notify() {
    return onTaskChange(snapshot());
  }

  function findNextQueuedTask() {
    return snapshot().find(task => task.status === 'queued') || null;
  }

  async function persistAndNotify(task) {
    task.updatedAt = Date.now();
    await persistTask(task);
    await notify();
  }

  async function deleteAndNotify(taskId) {
    await deleteTask(taskId);
    await notify();
  }

  async function runLoop() {
    if (running) return loopPromise;
    running = true;
    loopPromise = (async () => {
      try {
      while (true) {
        const task = findNextQueuedTask();
        if (!task) break;
        task.status = 'running';
        task.error = '';
        await persistAndNotify(task);
        try {
          const result = await executeTask(task);
          task.status = 'done';
          task.resultRecordId = String(result?.record?.id || result?.recordId || task.resultRecordId || '');
          await persistAndNotify(task);
          await onTaskDone(task, result || null);
        } catch (error) {
          task.status = 'failed';
          task.error = error?.message || 'Task failed';
          await persistAndNotify(task);
        }
      }
      } finally {
        running = false;
        await notify();
        loopPromise = null;
      }
    })();
    return loopPromise;
  }

  return {
    async restoreAndStart() {
      const restored = sortTasks(await loadTasks());
      tasks.length = 0;
      for (const raw of restored) {
        const task = createQueueTaskSnapshot(raw);
        if (task.status === 'running') task.status = 'queued';
        tasks.push(task);
        await persistTask(task);
      }
      await notify();
      void runLoop();
      return snapshot();
    },
    async enqueueTask(draft) {
      const task = createQueueTaskSnapshot(draft);
      if (!task.id) throw new Error('Task id is required');
      tasks.push(task);
      await persistAndNotify(task);
      void runLoop();
      return task;
    },
    async removeTask(taskId) {
      const id = String(taskId || '').trim();
      if (!id) return false;
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) return false;
      const task = tasks[index];
      if (task.status === 'running') return false;
      tasks.splice(index, 1);
      await deleteAndNotify(id);
      return true;
    },
    async flush() {
      await runLoop();
      return snapshot();
    },
    isRunning() {
      return running;
    },
    getSnapshot() {
      return snapshot();
    },
  };
}
