import fs from 'node:fs/promises';
import path from 'node:path';

import { MAX_UPLOAD_BYTES, UPLOAD_DIR } from './config.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/pjpeg']);

export function validateUploadFile(file) {
  if (!file || Number(file.size || 0) <= 0) {
    return { ok: false, reason: '无效的上传文件' };
  }

  if (Number(file.size) > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: '单张图片不能超过 5MB' };
  }

  const mime = String(file.mimetype || '').toLowerCase().trim();
  const extOk = /\.(jpe?g|png)$/i.test(String(file.originalname || ''));
  if (!ALLOWED_MIME.has(mime) && !extOk) {
    return { ok: false, reason: '仅支持 JPG、JPEG 和 PNG 图片' };
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

export async function cleanupExpiredUploads(uploadDir = UPLOAD_DIR, options = {}) {
  const retentionDays = Number(options.retentionDays || 7);
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);

  await fs.mkdir(uploadDir, { recursive: true });
  await walkUploadTree(uploadDir, async (entryPath, entry, stats) => {
    if (entry.name === '.gitignore') return;
    if (stats.mtimeMs >= cutoffMs) return;

    if (entry.isDirectory()) {
      const children = await fs.readdir(entryPath);
      if (children.length === 0) {
        await fs.rmdir(entryPath);
      }
      return;
    }

    await fs.unlink(entryPath);
  });
}

async function walkUploadTree(dir, visit) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const stats = await fs.stat(entryPath);
    if (entry.isDirectory()) {
      await walkUploadTree(entryPath, visit);
      await visit(entryPath, entry, stats);
      continue;
    }
    await visit(entryPath, entry, stats);
  }
}
