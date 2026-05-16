import test from 'node:test';
import assert from 'node:assert/strict';
import { setStaticCacheHeaders } from '../server/cache.js';

test('static cache headers disable browser cache for frontend assets', () => {
  const headers = new Map();
  const res = {
    setHeader(name, value) {
      headers.set(name, value);
    },
  };

  setStaticCacheHeaders(res, 'E:/github/image2/assets/js/app.js');

  assert.equal(headers.get('Cache-Control'), 'no-store, max-age=0');
});
