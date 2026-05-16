import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolishText } from '../assets/js/prompt-polish.js';

test('polish text normalizes rich editor text without losing paragraphs', () => {
  assert.equal(
    normalizePolishText('  第一段\r\n\r\n\r\n第二段  '),
    '第一段\n\n第二段',
  );
});

test('polish text removes invisible zero-width characters', () => {
  assert.equal(normalizePolishText('\u200b五岁小男孩\u200d'), '五岁小男孩');
});
