import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDetailModalHtml } from '../assets/js/detail-modal.js';

test('detail modal html renders image, prompt, revised prompt, and params', () => {
  const html = renderDetailModalHtml({
    prompt: 'red square icon',
    revisedPrompt: 'A clean red square app icon on a white background',
    showRevisedPrompt: true,
    displayParams: [{ key: 'size', label: '尺寸', actual: '1536x1024', requested: '1024x1024' }],
    activeImage: { url: 'blob:1' },
    imageIndex: 0,
    imageCount: 2,
    status: 'done',
    resolution: '1536x1024',
    duration: '12.8 秒',
  });

  assert.match(html, /detail-preview-image/);
  assert.match(html, /自动优化/);
  assert.match(html, /1536x1024/);
  assert.match(html, /记录信息/);
  assert.match(html, /12\.8 秒/);
  assert.match(html, /detail-section-head/);
  assert.doesNotMatch(html, /<div class="detail-param-label">状态<\/div>/);
  assert.doesNotMatch(html, /<div class="detail-param-label">分辨率<\/div>/);
  assert.doesNotMatch(html, /<div class="detail-param-label">生成时长<\/div>/);
});

test('detail modal shows page info for multi-image records', () => {
  const html = renderDetailModalHtml({
    prompt: 'prompt',
    revisedPrompt: '',
    showRevisedPrompt: false,
    displayParams: [],
    activeImage: { url: 'blob:2' },
    imageIndex: 1,
    imageCount: 3,
    status: 'done',
    resolution: '',
    duration: '',
  });

  assert.match(html, /2 \/ 3/);
});
