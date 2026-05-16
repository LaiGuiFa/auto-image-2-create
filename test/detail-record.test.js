import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetailViewModel, createDetailRecordPayload } from '../assets/js/detail-record.js';

test('detail record prefers actual params and only shows revised prompt when changed', () => {
  const model = buildDetailViewModel({
    id: 'rec-1',
    prompt: 'red square icon',
    revisedPrompt: 'A clean red square app icon on a white background',
    requestedParams: { size: '1024x1024', quality: 'medium', format: 'png', count: 1 },
    actualParams: { size: '1536x1024', quality: 'high', format: 'png', count: 1 },
    images: [{ url: 'blob:1' }, { url: 'blob:2' }],
  }, 0);

  assert.equal(model.showRevisedPrompt, true);
  assert.equal(model.revisedPrompt, 'A clean red square app icon on a white background');
  assert.deepEqual(model.displayParams[0], {
    key: 'size',
    label: '请求尺寸',
    actual: '1536x1024',
    requested: '1024x1024',
  });
});

test('detail record exposes real image resolution and duration', () => {
  const model = buildDetailViewModel({
    id: 'rec-1',
    prompt: 'red square icon',
    requestedParams: { size: '1024x1024', quality: 'medium', format: 'png', count: 1 },
    actualParams: null,
    images: [{ url: 'blob:1', width: 1536, height: 1024 }],
    durationMs: 12840,
  }, 0);

  assert.equal(model.resolution, '1536x1024');
  assert.equal(model.duration, '12.8 秒');
  assert.deepEqual(model.displayParams[0], {
    key: 'size',
    label: '请求尺寸',
    actual: null,
    requested: '1024x1024',
  });
});

test('detail record payload stores requested and actual params plus revised prompt', () => {
  const payload = createDetailRecordPayload({
    prompt: 'red square icon',
    size: '1024x1024',
    quality: 'medium',
    format: 'png',
    count: 1,
    durationMs: 3210,
    result: {
      actualParams: { size: '1536x1024', quality: 'high' },
      revisedPrompts: ['A clean red square app icon on a white background'],
    },
  });

  assert.equal(payload.revisedPrompt, 'A clean red square app icon on a white background');
  assert.equal(payload.durationMs, 3210);
  assert.deepEqual(payload.requestedParams, {
    size: '1024x1024',
    quality: 'medium',
    format: 'png',
    count: 1,
  });
});
