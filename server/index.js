import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT_DIR, ROUTES, UPLOAD_DIR } from './config.js';
import { setStaticCacheHeaders } from './cache.js';
import { buildPollUrl, getProxyTarget, requestWantsStream } from './proxy.js';
import { buildUploadLocation, ensureUploadDir, validateUploadFile } from './upload.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

const app = express();
const PORT = Number(process.env.PORT || 8000);

app.use(express.static(ROOT_DIR, { setHeaders: setStaticCacheHeaders }));
app.use('/uploads', express.static(UPLOAD_DIR));

app.post(ROUTES.upload, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, error: '未收到文件' });
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

app.post(ROUTES.imageSync, express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  const auth = getAuthorizationHeader(req);
  if (!auth) {
    res.status(401).json({ ok: false, error: 'Missing Authorization header' });
    return;
  }

  const rawBody = typeof req.body === 'string' ? req.body : '';
  try {
    const upstream = await fetch(getProxyTarget('sync'), {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: requestWantsStream(rawBody) ? 'text/event-stream, application/json' : 'application/json',
      },
      body: rawBody,
    });

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
    res.status(401).json({ ok: false, error: 'Missing Authorization header' });
    return;
  }

  try {
    const upstream = await fetch(getProxyTarget('async'), {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: typeof req.body === 'string' ? req.body : '',
    });
    await proxyJsonResponse(upstream, res);
  } catch (error) {
    handleUpstreamError(error, res);
  }
});

app.get(ROUTES.imagePoll, async (req, res) => {
  const taskId = String(req.query.task_id || '').trim();
  if (!taskId) {
    res.status(400).json({ ok: false, error: 'Missing task_id' });
    return;
  }

  const auth = getAuthorizationHeader(req);
  if (!auth) {
    res.status(401).json({ ok: false, error: 'Missing Authorization header' });
    return;
  }

  try {
    const upstream = await fetch(buildPollUrl(taskId), {
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
    });
    await proxyJsonResponse(upstream, res);
  } catch (error) {
    handleUpstreamError(error, res);
  }
});

function getAuthorizationHeader(req) {
  const value = req.get('authorization');
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isEventStream(contentType) {
  return String(contentType || '').toLowerCase().includes('text/event-stream');
}

async function proxyJsonResponse(upstream, res) {
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  res.send(text);
}

function handleUpstreamError(error, res) {
  const detail = error instanceof Error
    ? [error.message, error.cause?.message].filter(Boolean).join(': ')
    : 'Upstream request failed';
  res.status(502).json({
    ok: false,
    error: detail || 'Upstream request failed',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}

export { app };
