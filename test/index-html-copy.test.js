import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('index.html keeps critical Chinese UI copy readable', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /AI·创意工作台/);
  assert.match(html, /生图模式/);
  assert.match(html, /提示词工具/);
  assert.match(html, /参考图/);
  assert.doesNotMatch(html, /鍒涙剰宸ヤ綔鍙/);
});

test('index.html keeps only the quick polish entry in the prompt toolbar', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /id="polishPromptBtn"/);
  assert.match(html, /id="quickPolishPromptBtn"/);
});
