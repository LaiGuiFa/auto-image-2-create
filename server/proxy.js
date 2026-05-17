export function resolveProvider(runtimeConfig, providerId) {
  const requestedId = String(providerId || '').trim();
  if (requestedId) {
    const requested = runtimeConfig.providers.find((provider) => provider.id === requestedId);
    if (!requested) {
      throw createProxyError(400, `未找到图像服务：${requestedId}`);
    }
    return requested;
  }

  return runtimeConfig.providers.find((provider) => provider.id === runtimeConfig.defaultProviderId)
    || runtimeConfig.providers[0];
}

export function getProxyTarget(provider, action) {
  if (action === 'sync') return joinProviderUrl(provider.baseUrl, provider.syncPath);
  if (action === 'edit') {
    if (!provider.editPath) {
      throw createProxyError(400, `Image provider "${provider.id}" does not support reference-image edits`);
    }
    return joinProviderUrl(provider.baseUrl, provider.editPath);
  }
  if (action === 'async') return joinProviderUrl(provider.baseUrl, provider.asyncPath);
  throw new Error(`Unknown action: ${action}`);
}

export function buildPollUrl(provider, taskId) {
  return `${joinProviderUrl(provider.baseUrl, provider.pollPathBase)}${encodeURIComponent(taskId)}`;
}

export function requestWantsStream(rawBody) {
  if (!rawBody) return false;
  try {
    const json = JSON.parse(rawBody);
    return json?.stream === true;
  } catch {
    return false;
  }
}

export function readRequestMetadata(rawBody, query = {}) {
  const body = tryParseJson(rawBody);
  return {
    providerId: body?.providerId || query.providerId,
  };
}

export function assertProviderSupportsAction(provider, action) {
  if ((action === 'async' || action === 'poll') && !provider.supportsAsync) {
    throw createProxyError(400, `图像服务“${provider.id}”不支持异步请求`);
  }
}

function tryParseJson(rawBody) {
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

export function createProxyError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function joinProviderUrl(baseUrl, path) {
  const left = String(baseUrl || '').replace(/\/+$/, '');
  const right = String(path || '');
  if (!left) return right;
  if (!right) return left;
  return right.startsWith('/') ? `${left}${right}` : `${left}/${right}`;
}
