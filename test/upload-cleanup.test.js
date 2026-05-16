import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cleanupExpiredUploads, validateUploadFile } from '../server/upload.js';

test('cleanupExpiredUploads removes files older than retention but preserves .gitignore', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-upload-cleanup-'));
  const uploadsDir = path.join(root, 'uploads');
  const nestedDir = path.join(uploadsDir, '2026', '05', '01');
  await fs.mkdir(nestedDir, { recursive: true });

  const oldFile = path.join(nestedDir, 'old.png');
  const freshFile = path.join(uploadsDir, 'fresh.png');
  const gitignore = path.join(uploadsDir, '.gitignore');

  await fs.writeFile(oldFile, 'old');
  await fs.writeFile(freshFile, 'fresh');
  await fs.writeFile(gitignore, '*\n!.gitignore\n');

  const oldTime = new Date('2026-05-01T00:00:00Z');
  const freshTime = new Date('2026-05-15T00:00:00Z');
  await fs.utimes(oldFile, oldTime, oldTime);
  await fs.utimes(freshFile, freshTime, freshTime);
  await fs.utimes(gitignore, oldTime, oldTime);

  await cleanupExpiredUploads(uploadsDir, { retentionDays: 7, now: new Date('2026-05-16T00:00:00Z') });

  await assert.rejects(fs.access(oldFile));
  await fs.access(freshFile);
  await fs.access(gitignore);
});

test('validateUploadFile returns readable failure text', () => {
  assert.deepEqual(validateUploadFile(null), {
    ok: false,
    reason: '无效的上传文件',
  });

  assert.deepEqual(validateUploadFile({
    size: 6 * 1024 * 1024,
    mimetype: 'image/png',
    originalname: 'large.png',
  }), {
    ok: false,
    reason: '单张图片不能超过 5MB',
  });

  assert.deepEqual(validateUploadFile({
    size: 1024,
    mimetype: 'application/pdf',
    originalname: 'file.pdf',
  }), {
    ok: false,
    reason: '仅支持 JPG、JPEG 和 PNG 图片',
  });
});
