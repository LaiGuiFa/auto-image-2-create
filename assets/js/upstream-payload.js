export function normalizeUpstreamQuality(quality) {
  const q = String(quality || '').toLowerCase();
  if (q === 'high') return 'high';
  return 'medium';
}

function collectImageUrls(refImages) {
  return (Array.isArray(refImages) ? refImages : [])
    .map(item => item?.url)
    .filter(url => typeof url === 'string' && url.trim());
}

export function buildSyncPayload({ prompt, size, quality, count, refImages }) {
  const payload = {
    model: 'gpt-image-2',
    prompt,
    size,
    quality: normalizeUpstreamQuality(quality),
    response_format: 'b64_json',
    n: Math.max(1, Number(count) || 1),
  };

  const imageUrls = collectImageUrls(refImages);
  if (imageUrls.length) payload.image_urls = imageUrls;
  return payload;
}

export function buildAsyncPayload({ prompt, size, quality, refImages }) {
  const payload = {
    model: 'gpt-image-2',
    prompt,
    size,
    quality: normalizeUpstreamQuality(quality),
  };

  const imageUrls = collectImageUrls(refImages);
  if (imageUrls.length) payload.image_urls = imageUrls;
  return payload;
}

export function attachRequestMetadata(payload, { providerId } = {}) {
  return {
    ...payload,
    providerId: String(providerId || '').trim(),
  };
}

export function buildPollRequestUrl(baseUrl, { providerId } = {}) {
  const [path, query = ''] = String(baseUrl || '').split('?');
  const params = new URLSearchParams(query);
  const normalizedProviderId = String(providerId || '').trim();
  if (normalizedProviderId) params.set('providerId', normalizedProviderId);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}
