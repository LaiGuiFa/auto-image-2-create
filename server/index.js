import 'dotenv/config';
import { execFile } from 'node:child_process';
import express from 'express';
import multer from 'multer';
import { Blob } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { COLLECTION_DIR, ROOT_DIR, ROUTES, UPLOAD_DIR, parseRuntimeConfig } from './config.js';
import { setStaticCacheHeaders } from './cache.js';
import { fetchWithTimeout } from './fetch.js';
import { assertProviderSupportsAction, buildPollUrl, getProxyTarget, readRequestMetadata, requestWantsStream, resolveProvider } from './proxy.js';
import { buildUploadLocation, cleanupExpiredUploads, ensureUploadDir, validateUploadFile } from './upload.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT || 8000);
const execFileAsync = promisify(execFile);

export function createApp(options = {}) {
  const runtimeConfig = options.runtimeConfig || parseRuntimeConfig();
  const fetchImpl = options.fetchImpl || fetch;
  const startupTasks = options.startupTasks !== false;
  const pickDownloadDirectoryImpl = options.pickDownloadDirectory || pickDownloadDirectory;

  const app = express();

  app.use(express.static(ROOT_DIR, { setHeaders: setStaticCacheHeaders }));
  app.use('/uploads', express.static(UPLOAD_DIR));
  app.use('/collection', express.static(COLLECTION_DIR));

  if (startupTasks) {
    void cleanupExpiredUploads(UPLOAD_DIR, {
      retentionDays: runtimeConfig.uploadRetentionDays,
    });
    void ensureCollectionDir();
  }

  app.get(ROUTES.runtimeConfig, (_req, res) => {
    res.json({
      ok: true,
      defaultProviderId: runtimeConfig.defaultProviderId,
      providers: runtimeConfig.publicProviders,
      deepseekConfigured: runtimeConfig.deepseek.enabled,
      requestTimeoutMs: runtimeConfig.requestTimeoutMs,
      uploadRetentionDays: runtimeConfig.uploadRetentionDays,
    });
  });

  app.post(ROUTES.upload, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ ok: false, error: '请选择要上传的图片' });
      return;
    }

    const validation = validateUploadFile(file);
    if (!validation.ok) {
      res.status(400).json({ ok: false, error: validation.reason });
      return;
    }

    const location = buildUploadLocation(file.originalname);
    const fullDir = await ensureUploadDir(location.relativeDir);
    const fullPath = path.join(fullDir, location.filename);
    await fs.writeFile(fullPath, file.buffer);

    const relativePath = `${location.relativeDir.split(path.sep).join('/')}/${location.filename}`;
    const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${relativePath}`;
    res.json({ ok: true, url: publicUrl });
  });

  app.get(ROUTES.collection, async (_req, res) => {
    try {
      const manifest = await readCollectionManifest();
      res.json({ ok: true, items: manifest.items || [] });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '读取收藏失败' });
    }
  });

  app.post(ROUTES.collection, upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ ok: false, error: '缺少收藏图片文件' });
        return;
      }

      const validation = validateCollectionUploadFile(file);
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: validation.reason });
        return;
      }

      const manifest = await readCollectionManifest();
      const recordId = String(req.body?.recordId || '').trim();
      const imageIndex = Number.parseInt(String(req.body?.imageIndex || '0'), 10) || 0;
      const existing = manifest.items.find(item => item.recordId === recordId && item.imageIndex === imageIndex);
      if (existing) {
        res.json({ ok: true, item: existing, duplicated: true });
        return;
      }

      const savedAt = Number.parseInt(String(req.body?.savedAt || Date.now()), 10) || Date.now();
      const stamp = formatCollectionStamp(savedAt);
      const ext = path.extname(file.originalname || '').toLowerCase() || mimeExt(file.mimetype);
      const filename = await allocateCollectionFilename(stamp, ext);
      await fs.writeFile(path.join(COLLECTION_DIR, filename), file.buffer);

      const item = {
        id: filename,
        filename,
        url: `/collection/${filename}`,
        savedAt,
        prompt: String(req.body?.prompt || '').trim(),
        size: String(req.body?.size || '').trim(),
        quality: String(req.body?.quality || '').trim(),
        format: String(req.body?.format || '').trim(),
        recordId,
        imageIndex,
      };
      manifest.items.unshift(item);
      await writeCollectionManifest(manifest);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '保存收藏失败' });
    }
  });

  app.delete(`${ROUTES.collection}/:id`, async (req, res) => {
    try {
      const id = path.basename(String(req.params.id || '').trim());
      if (!id) {
        res.status(400).json({ ok: false, error: '缺少收藏 ID' });
        return;
      }
      const manifest = await readCollectionManifest();
      const nextItems = manifest.items.filter(item => item.id !== id);
      if (nextItems.length === manifest.items.length) {
        res.status(404).json({ ok: false, error: '收藏不存在' });
        return;
      }
      manifest.items = nextItems;
      await writeCollectionManifest(manifest);
      await fs.unlink(path.join(COLLECTION_DIR, id)).catch(() => {});
      res.json({ ok: true, id });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || '删除收藏失败' });
    }
  });

  app.post(ROUTES.downloadDirectoryPick, async (_req, res) => {
    try {
      const selectedPath = await pickDownloadDirectoryImpl();
      if (!selectedPath) {
        res.json({ ok: false, cancelled: true });
        return;
      }
      res.json({ ok: true, path: selectedPath });
    } catch (error) {
      res.status(error?.status || 500).json({
        ok: false,
        error: error.message || '选择下载路径失败',
      });
    }
  });

  app.post(ROUTES.downloadImage, upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ ok: false, error: '缺少图片文件' });
        return;
      }

      const validation = validateCollectionUploadFile(file);
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: validation.reason });
        return;
      }

      const targetDir = normalizeDownloadDirectory(req.body?.targetDir);
      await assertWritableDirectory(targetDir);
      const ext = path.extname(file.originalname || '').toLowerCase() || mimeExt(file.mimetype);
      const filename = sanitizeDownloadFilename(req.body?.filename, ext);
      const finalPath = await allocateDownloadFilename(targetDir, filename);
      await fs.writeFile(finalPath, file.buffer);
      res.json({ ok: true, path: finalPath });
    } catch (error) {
      res.status(error?.status || 500).json({
        ok: false,
        error: error.message || '保存图片失败',
      });
    }
  });

  app.post(ROUTES.imageSync, imageSyncBodyParser, async (req, res) => {
    const auth = getAuthorizationHeader(req);
    if (!auth) {
      res.status(401).json({ ok: false, error: '缺少 Authorization 请求头' });
      return;
    }

    try {
      if (Array.isArray(req.files) && req.files.length > 0) {
        await proxyMultipartImageEdit(req, res, {
          runtimeConfig,
          fetchImpl,
          auth,
        });
        return;
      }

      const rawBody = typeof req.body === 'string' ? req.body : '';
      const metadata = readRequestMetadata(rawBody);
      const provider = resolveProvider(runtimeConfig, metadata.providerId);
      const targetUrl = getProxyTarget(provider, 'sync');
      const upstream = await fetchProvider(targetUrl, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: requestWantsStream(rawBody) ? 'text/event-stream, application/json' : 'application/json',
        },
        body: rawBody,
      }, runtimeConfig.requestTimeoutMs, fetchImpl, provider.id, 'provider');

      if (requestWantsStream(rawBody) && isEventStream(upstream.headers.get('content-type'))) {
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        if (!upstream.body) {
          res.end();
          return;
        }
        for await (const chunk of upstream.body) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      await proxyJsonResponse(upstream, res);
    } catch (error) {
      handleUpstreamError(error, res);
    }
  });

  app.post(ROUTES.imageAsync, express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
    const auth = getAuthorizationHeader(req);
    if (!auth) {
      res.status(401).json({ ok: false, error: '缺少 Authorization 请求头' });
      return;
    }

    const rawBody = typeof req.body === 'string' ? req.body : '';
    try {
      const metadata = readRequestMetadata(rawBody);
      const provider = resolveProvider(runtimeConfig, metadata.providerId);
      assertProviderSupportsAction(provider, 'async');
      const targetUrl = getProxyTarget(provider, 'async');
      const upstream = await fetchProvider(targetUrl, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: rawBody,
      }, runtimeConfig.requestTimeoutMs, fetchImpl, provider.id, 'provider');
      await proxyJsonResponse(upstream, res);
    } catch (error) {
      handleUpstreamError(error, res);
    }
  });

  app.get(ROUTES.imagePoll, async (req, res) => {
    const taskId = String(req.query.task_id || '').trim();
    if (!taskId) {
      res.status(400).json({ ok: false, error: '缺少任务 ID' });
      return;
    }

    const auth = getAuthorizationHeader(req);
    if (!auth) {
      res.status(401).json({ ok: false, error: '缺少 Authorization 请求头' });
      return;
    }

    try {
      const metadata = readRequestMetadata('', req.query);
      const provider = resolveProvider(runtimeConfig, metadata.providerId);
      assertProviderSupportsAction(provider, 'poll');
      const targetUrl = buildPollUrl(provider, taskId);
      const upstream = await fetchProvider(targetUrl, {
        headers: {
          Authorization: auth,
          Accept: 'application/json',
        },
      }, runtimeConfig.requestTimeoutMs, fetchImpl, provider.id, 'provider');
      await proxyJsonResponse(upstream, res);
    } catch (error) {
      handleUpstreamError(error, res);
    }
  });

  app.post(ROUTES.polish, express.json({ limit: '1mb' }), async (req, res) => {
    if (!runtimeConfig.deepseek.enabled) {
      res.status(503).json({
        ok: false,
        error: '服务端未配置 Prompt 润色功能',
      });
      return;
    }

    const text = String(req.body?.text || req.body?.prompt || '').trim();
    if (!text) {
      res.status(400).json({ ok: false, error: '缺少润色文本' });
      return;
    }

    try {
      const upstream = await fetchWithTimeout(runtimeConfig.deepseek.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtimeConfig.deepseek.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: runtimeConfig.deepseek.model,
          messages: [
            {
              role: 'system',
              content: runtimeConfig.deepseek.systemPrompt,
            },
            {
              role: 'user',
              content: text,
            },
          ],
        }),
      }, runtimeConfig.requestTimeoutMs, fetchImpl, 'polish');

      const raw = await upstream.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      const polished = payload?.choices?.[0]?.message?.content;
      if (!upstream.ok || !polished) {
        res.status(upstream.status || 502).json({
          ok: false,
          error: payload?.error?.message || (payload ? 'Prompt polish failed' : 'DeepSeek returned a non-JSON error response'),
        });
        return;
      }

      res.json({ ok: true, text: polished });
    } catch (error) {
      handleUpstreamError(error, res);
    }
  });

  return app;
}

function imageSyncBodyParser(req, res, next) {
  const contentType = String(req.get('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    upload.any()(req, res, next);
    return;
  }
  express.text({ type: 'application/json', limit: '10mb' })(req, res, next);
}

async function ensureCollectionDir() {
  await fs.mkdir(COLLECTION_DIR, { recursive: true });
}

async function readCollectionManifest() {
  await ensureCollectionDir();
  const manifestPath = path.join(COLLECTION_DIR, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const json = JSON.parse(raw);
    if (!json || !Array.isArray(json.items)) return { items: [] };
    return json;
  } catch {
    return { items: [] };
  }
}

async function writeCollectionManifest(manifest) {
  await ensureCollectionDir();
  const manifestPath = path.join(COLLECTION_DIR, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify({ items: manifest.items || [] }, null, 2)}\n`);
}

async function allocateCollectionFilename(stamp, ext) {
  await ensureCollectionDir();
  let name = `${stamp}${ext}`;
  let full = path.join(COLLECTION_DIR, name);
  let suffix = 2;
  while (true) {
    try {
      await fs.access(full);
      name = `${stamp}-${suffix}${ext}`;
      full = path.join(COLLECTION_DIR, name);
      suffix += 1;
    } catch {
      return name;
    }
  }
}

function formatCollectionStamp(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd}-${hh}-${mi}`;
}

function mimeExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/webp') return '.webp';
  return '.png';
}

function validateCollectionUploadFile(file) {
  if (!file || Number(file.size || 0) <= 0) {
    return { ok: false, reason: '无效的收藏文件' };
  }
  const mime = String(file.mimetype || '').toLowerCase().trim();
  const extOk = /\.(jpe?g|png|webp)$/i.test(String(file.originalname || ''));
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/pjpeg'].includes(mime) && !extOk) {
    return { ok: false, reason: '仅支持 JPG、PNG、WEBP 图片' };
  }
  return { ok: true };
}

async function pickDownloadDirectory() {
  if (process.platform !== 'win32') {
    const error = new Error('当前系统暂不支持从服务端打开目录选择器');
    error.status = 501;
    throw error;
  }
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择图片下载保存路径'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: false,
    timeout: 120000,
  });
  return String(stdout || '').trim();
}

function normalizeDownloadDirectory(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('请先设置下载保存路径');
    error.status = 400;
    throw error;
  }
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(raw) || resolved !== raw) {
    const error = new Error('下载保存路径必须是绝对路径');
    error.status = 400;
    throw error;
  }
  return resolved;
}

async function assertWritableDirectory(dir) {
  let stat = null;
  try {
    stat = await fs.stat(dir);
  } catch {
    const error = new Error('下载保存路径不存在');
    error.status = 400;
    throw error;
  }
  if (!stat.isDirectory()) {
    const error = new Error('下载保存路径不是文件夹');
    error.status = 400;
    throw error;
  }
  try {
    await fs.access(dir, fsConstants.W_OK);
  } catch {
    const error = new Error('下载保存路径不可写');
    error.status = 400;
    throw error;
  }
}

function sanitizeDownloadFilename(value, fallbackExt = '.png') {
  const raw = path.basename(String(value || '').trim());
  const safe = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim();
  const ext = path.extname(safe) || fallbackExt || '.png';
  const stem = path.basename(safe, path.extname(safe)).trim() || `gpt-image-${Date.now()}`;
  return `${stem}${ext}`;
}

async function allocateDownloadFilename(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let name = filename;
  let full = path.join(dir, name);
  let suffix = 2;
  while (true) {
    try {
      await fs.access(full);
      name = `${stem}-${suffix}${ext}`;
      full = path.join(dir, name);
      suffix += 1;
    } catch {
      return full;
    }
  }
}

function getAuthorizationHeader(req) {
  const value = req.get('authorization');
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isEventStream(contentType) {
  return String(contentType || '').toLowerCase().includes('text/event-stream');
}

async function proxyJsonResponse(upstream, res) {
  if (upstream.status === 401 || upstream.status === 403) {
    res.status(502).json({
      ok: false,
      error: '图像服务认证失败，请检查 API Key',
      code: 'PROVIDER_AUTH',
    });
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  res.send(text);
}

function handleUpstreamError(error, res) {
  if (error?.code === 'PROVIDER_TIMEOUT' || error?.code === 'POLISH_TIMEOUT') {
    res.status(error.status || 504).json({
      ok: false,
      error: error.message,
      code: error.code,
    });
    return;
  }

  if (error?.status) {
    res.status(error.status).json({
      ok: false,
      error: error.message,
    });
    return;
  }

  const detail = error instanceof Error
    ? [error.message, error.cause?.message].filter(Boolean).join(': ')
    : '上游服务请求失败';
  res.status(502).json({
    ok: false,
    error: detail || '上游服务请求失败',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}

const app = null;

export { app };

function fetchProvider(url, options, timeoutMs, fetchImpl, providerId, timeoutType) {
  return fetchWithTimeout(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Image2-Provider-Id': providerId,
    },
  }, timeoutMs, fetchImpl, timeoutType);
}

async function proxyMultipartImageEdit(req, res, { runtimeConfig, fetchImpl, auth }) {
  const metadata = readRequestMetadata('', req.body || {});
  const provider = resolveProvider(runtimeConfig, metadata.providerId);
  const targetUrl = getProxyTarget(provider, 'edit');
  const form = new FormData();

  for (const [key, value] of Object.entries(req.body || {})) {
    if (key === 'providerId') continue;
    if (Array.isArray(value)) {
      value.forEach((item) => form.append(key, String(item)));
      continue;
    }
    if (value != null) {
      form.append(key, String(value));
    }
  }

  for (const file of req.files || []) {
    const blob = new Blob([file.buffer], { type: String(file.mimetype || 'application/octet-stream') });
    form.append(file.fieldname, blob, file.originalname || 'reference.png');
  }

  const upstream = await fetchProvider(targetUrl, {
    method: 'POST',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
    body: form,
  }, runtimeConfig.requestTimeoutMs, fetchImpl, provider.id, 'provider');

  await proxyJsonResponse(upstream, res);
}
