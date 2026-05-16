import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachRequestMetadata,
  buildPollRequestUrl,
  buildSyncPayload,
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
