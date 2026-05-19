import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('index.html keeps critical Chinese UI copy readable', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /创意工坊/);
  assert.match(html, /生图模式/);
  assert.match(html, /任务队列/);
  assert.match(html, /参考图/);
});

test('index.html keeps only the quick polish entry in the prompt toolbar', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /id="polishPromptBtn"/);
  assert.match(html, /id="quickPolishPromptBtnBottom"/);
});
