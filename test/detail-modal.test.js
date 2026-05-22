import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDetailModalHtml } from '../assets/js/detail-modal.js';

test('detail modal html renders image, prompt, revised prompt, and params', () => {
  const html = renderDetailModalHtml({
    prompt: 'red square icon',
    revisedPrompt: 'A clean red square app icon on a white background',
    showRevisedPrompt: true,
    displayParams: [{ key: 'size', label: '请求尺寸', actual: '1536x1024', requested: '1024x1024' }],
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
});

test('detail modal html includes a download button for the preview image', () => {
  const html = renderDetailModalHtml({
    prompt: 'prompt',
    revisedPrompt: '',
    showRevisedPrompt: false,
    displayParams: [],
    activeImage: { url: 'blob:1' },
    imageIndex: 0,
    imageCount: 1,
    status: 'done',
    resolution: '',
    duration: '',
  });

  assert.match(html, /detail-preview-download-mask/);
  assert.match(html, /detail-preview-download-btn/);
  assert.match(html, /data-detail-download/);
  assert.doesNotMatch(html, /detail-preview-download-btn[^>]*top:/);
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
