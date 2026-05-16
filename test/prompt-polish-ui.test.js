import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPolishRequest,
  getPolishButtonLabel,
  getPolishDisabledState,
  readPolishResponseText,
} from '../assets/js/prompt-polish-ui.js';

test('polish request normalizes editor text before sending it to the backend', () => {
  assert.deepEqual(buildPolishRequest(' rough\r\n\r\ntext  '), {
    text: 'rough\n\ntext',
  });
});

test('polish ui helpers expose stable labels and reject empty backend payloads', () => {
  assert.equal(getPolishButtonLabel(false), 'ai润色');
  assert.equal(getPolishButtonLabel(true), '润色中...');
  assert.equal(readPolishResponseText({ ok: true, text: ' polished ' }), 'polished');
  assert.throws(() => readPolishResponseText({ ok: true, text: '   ' }), /润色结果为空/);
});

test('polish buttons stay clickable when service is unconfigured and only lock during requests', () => {
  assert.equal(getPolishDisabledState({ deepseekConfigured: false, loading: false }), false);
  assert.equal(getPolishDisabledState({ deepseekConfigured: true, loading: false }), false);
  assert.equal(getPolishDisabledState({ deepseekConfigured: false, loading: true }), true);
  assert.equal(getPolishDisabledState({ deepseekConfigured: true, loading: true }), true);
});
