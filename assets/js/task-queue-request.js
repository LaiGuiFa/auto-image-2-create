import { attachRequestMetadata, buildSyncPayload, hasReferenceImages } from './upstream-payload.js';

export function buildQueueTaskRequestPayload(task, { resolveSizeForChannel }) {
  const providerId = String(task?.providerId || '').trim();
  const size = task?.params?.size || '1024x1024';
  const quality = task?.params?.quality || 'medium';
  const count = Number(task?.params?.count) || 1;
  const refImages = Array.isArray(task?.refImages) ? task.refImages.map(img => ({ ...img })) : [];
  const body = attachRequestMetadata(buildSyncPayload({
    prompt: task?.prompt || '',
    size: resolveSizeForChannel(size, 'cnd'),
    quality,
    count,
    refImages,
  }), { providerId });

  if (task?.params?.moderation) body.moderation = 'low';
  if (task?.params?.streamEnabled) {
    body.stream = true;
    body.partial_images = 2;
  }

  return { body, refImages, providerId };
}

export async function buildQueueTaskRequestInit(task, options) {
  const {
    endpoint,
    apiKey,
    resolveSizeForChannel,
    buildReferenceEditFormData,
  } = options;
  const { body, refImages, providerId } = buildQueueTaskRequestPayload(task, { resolveSizeForChannel });
  const hasRefs = hasReferenceImages(refImages);
  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: null,
  };

  if (hasRefs) {
    requestInit.body = await buildReferenceEditFormData({
      prompt: task.prompt,
      size: resolveSizeForChannel(task?.params?.size || '1024x1024', 'cnd'),
      quality: body.quality,
      count: body.n,
      refImages,
      providerId,
    });
  } else {
    requestInit.headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(body);
  }

  return { endpoint, requestInit, body, providerId, hasRefs };
}
