import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachRequestMetadata,
  buildPollRequestUrl,
  buildSyncPayload,
  hasReferenceImages,
  normalizeUpstreamQuality,
} from '../assets/js/upstream-payload.js';

test('request metadata helper attaches provider field without mutating the input payload', () => {
  const payload = buildSyncPayload({
    prompt: 'city skyline',
    size: '1024x1024',
    quality: 'high',
    count: 1,
    refImages: [],
  });

  const enriched = attachRequestMetadata(payload, {
    providerId: 'alpha',
  });

  assert.equal(payload.providerId, undefined);
  assert.deepEqual(enriched, {
    model: 'gpt-image-2',
    prompt: 'city skyline',
    size: '1024x1024',
    quality: 'high',
    response_format: 'b64_json',
    n: 1,
    providerId: 'alpha',
  });
});

test('poll request url includes provider metadata as a query parameter', () => {
  assert.equal(
    buildPollRequestUrl('/api/image/poll?task_id=task-1', {
      providerId: 'alpha',
    }),
    '/api/image/poll?task_id=task-1&providerId=alpha',
  );
});

test('sync payload stays text-only and reference images are detected separately', () => {
  const payload = buildSyncPayload({
    prompt: 'improve this screenshot',
    size: '1024x1024',
    quality: 'medium',
    count: 1,
    refImages: [{ name: 'shot.png', url: 'http://127.0.0.1:8000/uploads/2026/05/16/shot.png' }],
  });

  assert.equal(payload.image_urls, undefined);
  assert.equal(hasReferenceImages([{ url: 'http://127.0.0.1/test.png' }]), true);
  assert.equal(hasReferenceImages([{ url: '   ' }]), false);
});

test('quality normalization preserves low medium and high', () => {
  assert.equal(normalizeUpstreamQuality('low'), 'low');
  assert.equal(normalizeUpstreamQuality('medium'), 'medium');
  assert.equal(normalizeUpstreamQuality('high'), 'high');
  assert.equal(normalizeUpstreamQuality('unexpected'), 'medium');
});

test('sync payload keeps low quality when selected', () => {
  const payload = buildSyncPayload({
    prompt: 'product hero shot',
    size: '1:1',
    quality: 'low',
    count: 1,
    refImages: [],
  });

  assert.equal(payload.size, '1:1');
  assert.equal(payload.quality, 'low');
});
