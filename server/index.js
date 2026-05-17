import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { Blob } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT_DIR, ROUTES, UPLOAD_DIR, parseRuntimeConfig } from './config.js';
import { setStaticCacheHeaders } from './cache.js';
import { fetchWithTimeout } from './fetch.js';
import { assertProviderSupportsAction, buildPollUrl, getProxyTarget, readRequestMetadata, requestWantsStream, resolveProvider } from './proxy.js';
import { buildUploadLocation, cleanupExpiredUploads, ensureUploadDir, validateUploadFile } from './upload.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT || 8000);

export function createApp(options = {}) {
  const runtimeConfig = options.runtimeConfig || parseRuntimeConfig();
  const fetchImpl = options.fetchImpl || fetch;
  const startupTasks = options.startupTasks !== false;

  const app = express();

  app.use(express.static(ROOT_DIR, { setHeaders: setStaticCacheHeaders }));
  app.use('/uploads', express.static(UPLOAD_DIR));

  if (startupTasks) {
    void cleanupExpiredUploads(UPLOAD_DIR, {
      retentionDays: runtimeConfig.uploadRetentionDays,
    });
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
      res.status(400).json({ ok: false, error: '璇烽€夋嫨瑕佷笂浼犵殑鍥剧墖' });
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
      res.status(400).json({ ok: false, error: '缂哄皯浠诲姟 ID' });
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
      res.status(400).json({ ok: false, error: '缂哄皯娑﹁壊鏂囨湰' });
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
    : '涓婃父鏈嶅姟璇锋眰澶辫触';
  res.status(502).json({
    ok: false,
    error: detail || '涓婃父鏈嶅姟璇锋眰澶辫触',
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
