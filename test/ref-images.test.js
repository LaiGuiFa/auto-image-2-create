import test from 'node:test';
import assert from 'node:assert/strict';
import { getReferenceImageAddState, makeHistoryReferenceImage } from '../assets/js/ref-images.js';

test('reference image add state blocks when slots are full', () => {
  assert.deepEqual(getReferenceImageAddState({
    currentCount: 1,
    asyncMode: 'sync',
    asyncDisabled: false,
  }), {
    ok: false,
    max: 1,
    reason: '同步模式最多 1 张参考图',
  });
});

test('history reference image uses a stable display name and data url', () => {
  assert.deepEqual(makeHistoryReferenceImage({
    recordId: 'abc12345',
    index: 1,
    dataUrl: 'data:image/png;base64,AAAA',
  }), {
    name: '历史图片 abc12345-2',
    url: 'data:image/png;base64,AAAA',
    source: 'history',
  });
});
