import fs from 'node:fs/promises';
import path from 'node:path';

import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from './config.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/pjpeg']);

export function validateUploadFile(file) {
  if (!file || Number(file.size || 0) <= 0) {
    return { ok: false, reason: '文件无效' };
  }

  if (Number(file.size) > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: '单张不能超过 5MB' };
  }

  const mime = String(file.mimetype || '').toLowerCase().trim();
  const extOk = /\.(jpe?g|png)$/i.test(String(file.originalname || ''));
  if (!ALLOWED_MIME.has(mime) && !extOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG、PNG' };
  }

  return { ok: true };
}

export function buildUploadLocation(originalname, now = new Date()) {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const ext = path.extname(originalname || '').toLowerCase() || '.jpg';
  const random = Math.random().toString(36).slice(2, 8);
  const filename = `${Date.now()}_${random}${ext}`;
  return {
    relativeDir: path.join(year, month, day),
    filename,
  };
}

export async function ensureUploadDir(relativeDir) {
  const fullDir = path.join(UPLOAD_DIR, relativeDir);
  await fs.mkdir(fullDir, { recursive: true });
  return fullDir;
}
