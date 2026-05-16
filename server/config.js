import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');
export const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

export const ROUTES = {
  upload: '/api/upload',
  imageSync: '/api/image/sync',
  imageAsync: '/api/image/async',
  imagePoll: '/api/image/poll',
};

export const UPSTREAM = {
  sync: 'https://muskpay.top/v1/images/generations',
  async: 'https://muskpay.top/v1/images/generations?async=true',
  pollBase: 'https://muskpay.top/v1/images/',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
