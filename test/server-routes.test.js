import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/index.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

const runtimeConfig = {
  defaultProviderId: 'alpha',
  publicProviders: [
    { id: 'alpha', label: 'Alpha', supportsAsync: true },
    { id: 'beta', label: 'Beta', supportsAsync: false },
  ],
  providers: [
    {
      id: 'alpha',
      label: 'Alpha',
      baseUrl: 'https://alpha.example',
      syncPath: '/sync',
      editPath: '/edits',
      asyncPath: '/async',
      pollPathBase: '/tasks/',
      supportsAsync: true,
    },
    {
      id: 'beta',
      label: 'Beta',
      baseUrl: 'https://beta.example',
      syncPath: '/sync',
      editPath: '',
      asyncPath: '',
      pollPathBase: '',
      supportsAsync: false,
    },
  ],
  deepseek: {
    enabled: false,
    apiKey: '',
    url: '',
    model: '',
    systemPrompt: '',
  },
  requestTimeoutMs: 300000,
  uploadRetentionDays: 7,
};

test('runtime config route returns only frontend-safe provider metadata', async () => {
  const app = createApp({ runtimeConfig, startupTasks: false });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/runtime-config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      defaultProviderId: 'alpha',
      providers: runtimeConfig.publicProviders,
      deepseekConfigured: false,
      requestTimeoutMs: 300000,
      uploadRetentionDays: 7,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('polish route returns a clear error when deepseek is not configured', async () => {
  const app = createApp({ runtimeConfig, startupTasks: false });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: '服务端未配置 Prompt 润色功能',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('poll route always uses direct provider urls', async () => {
  const calls = [];
  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        providerId: options.headers?.['X-Image2-Provider-Id'],
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const { server, baseUrl } = await listen(app);

  try {
    const first = await fetch(`${baseUrl}/api/image/poll?task_id=task-1&providerId=alpha`, {
      headers: { Authorization: 'Bearer token' },
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/api/image/poll?task_id=task-2&providerId=alpha`, {
      headers: { Authorization: 'Bearer token' },
    });
    assert.equal(second.status, 200);

    assert.deepEqual(calls, [
      { url: 'https://alpha.example/tasks/task-1', providerId: 'alpha' },
      { url: 'https://alpha.example/tasks/task-2', providerId: 'alpha' },
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('provider timeout paths return normalized timeout payloads', async () => {
  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'AbortError';
      throw error;
    },
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/image/poll?task_id=task-1&providerId=alpha`, {
      headers: { Authorization: 'Bearer token' },
    });

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: '图像服务请求超时',
      code: 'PROVIDER_TIMEOUT',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('polish timeout path returns normalized timeout payload', async () => {
  const app = createApp({
    runtimeConfig: {
      ...runtimeConfig,
      deepseek: {
        enabled: true,
        apiKey: 'secret',
        url: 'https://deepseek.example/chat',
        model: 'deepseek-chat',
        systemPrompt: 'polish this',
      },
    },
    startupTasks: false,
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'AbortError';
      throw error;
    },
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'Prompt 润色请求超时',
      code: 'POLISH_TIMEOUT',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('provider auth failures return normalized backend payloads', async () => {
  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/image/sync`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: 'alpha' }),
    });

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: '图像服务认证失败，请检查 API Key',
      code: 'PROVIDER_AUTH',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('sync route forwards multipart reference-image requests to the provider edit path', async () => {
  const calls = [];
  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        providerId: options.headers?.['X-Image2-Provider-Id'],
        contentType: options.headers?.['Content-Type'] || options.headers?.['content-type'] || '',
        bodyType: options.body?.constructor?.name || typeof options.body,
      });
      return new Response(JSON.stringify({
        data: [{ b64_json: 'aGVsbG8=' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const { server, baseUrl } = await listen(app);

  try {
    const form = new FormData();
    form.append('providerId', 'alpha');
    form.append('model', 'gpt-image-2');
    form.append('prompt', 'improve this screenshot');
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append('image[]', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'ref.png');

    const res = await fetch(`${baseUrl}/api/image/sync`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
      },
      body: form,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{
      url: 'https://alpha.example/edits',
      providerId: 'alpha',
      contentType: '',
      bodyType: 'FormData',
    }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('polish route returns polished text when deepseek is configured', async () => {
  const app = createApp({
    runtimeConfig: {
      ...runtimeConfig,
      deepseek: {
        enabled: true,
        apiKey: 'secret',
        url: 'https://deepseek.example/chat',
        model: 'deepseek-chat',
        systemPrompt: 'polish this',
      },
    },
    startupTasks: false,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: 'polished prompt text',
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'rough prompt' }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      text: 'polished prompt text',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('polish route returns a readable error when upstream responds with a non-json bad gateway body', async () => {
  const app = createApp({
    runtimeConfig: {
      ...runtimeConfig,
      deepseek: {
        enabled: true,
        apiKey: 'secret',
        url: 'https://deepseek.example/chat',
        model: 'deepseek-chat',
        systemPrompt: 'polish this',
      },
    },
    startupTasks: false,
    fetchImpl: async () => new Response('Bad Gateway', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'rough prompt' }),
    });

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'DeepSeek returned a non-JSON error response',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('upload route returns readable size validation text', async () => {
  const app = createApp({ runtimeConfig, startupTasks: false });
  const { server, baseUrl } = await listen(app);

  try {
    const form = new FormData();
    const oversized = new Uint8Array((5 * 1024 * 1024) + 1);
    form.append('file', new Blob([oversized], { type: 'image/png' }), 'large.png');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: form,
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: '单张图片不能超过 5MB',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('sync route preserves SSE passthrough in direct mode', async () => {
  const chunks = ['data: {"step":1}\n\n', 'data: [DONE]\n\n'];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks[0]));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(chunks[1]));
        controller.close();
      }, 25);
    },
  });

  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/image/sync`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: 'alpha', stream: true }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/i);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.match(await res.text(), /\[DONE\]/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('download directory picker returns the selected absolute path', async () => {
  const chosen = path.join(os.tmpdir(), `image2-download-${Date.now()}`);
  const app = createApp({
    runtimeConfig,
    startupTasks: false,
    pickDownloadDirectory: async () => chosen,
  });
  const { server, baseUrl } = await listen(app);

  try {
    const res = await fetch(`${baseUrl}/api/download-directory/pick`, {
      method: 'POST',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      path: chosen,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('download image route writes files to the selected absolute directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-download-save-'));
  const app = createApp({ runtimeConfig, startupTasks: false });
  const { server, baseUrl } = await listen(app);

  try {
    const form = new FormData();
    form.append('targetDir', dir);
    form.append('filename', 'gpt-image-test.png');
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'gpt-image-test.png');

    const res = await fetch(`${baseUrl}/api/download-image`, {
      method: 'POST',
      body: form,
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.match(json.path, new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]gpt-image-test\\.png$`));
    const saved = await fs.readFile(json.path);
    assert.deepEqual([...saved], [1, 2, 3]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
