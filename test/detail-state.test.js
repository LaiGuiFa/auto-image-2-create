import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailState } from '../assets/js/detail-state.js';

test('detail state opens, clamps index, and navigates within image count', () => {
  const state = createDetailState();

  state.open({ recordId: 'rec-1', imageIndex: 9, imageCount: 3 });
  assert.equal(state.getSnapshot().open, true);
  assert.equal(state.getSnapshot().recordId, 'rec-1');
  assert.equal(state.getSnapshot().imageIndex, 2);

  state.prev();
  assert.equal(state.getSnapshot().imageIndex, 1);

  state.next();
  state.next();
  assert.equal(state.getSnapshot().imageIndex, 2);

  state.close();
  assert.equal(state.getSnapshot().open, false);
});
