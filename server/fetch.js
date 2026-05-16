export async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 300000,
  fetchImpl = fetch,
  timeoutType = 'provider',
) {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (didTimeout || error?.name === 'AbortError' || controller.signal.aborted) {
      throw createTimeoutError(timeoutType);
    }
    throw error;
  } finally {
    didTimeout = controller.signal.aborted;
    clearTimeout(timeoutId);
  }
}

function createTimeoutError(timeoutType) {
  if (timeoutType === 'polish') {
    return Object.assign(new Error('Prompt 润色请求超时'), {
      status: 504,
      code: 'POLISH_TIMEOUT',
      timeoutType,
    });
  }

  return Object.assign(new Error('图像服务请求超时'), {
    status: 504,
    code: 'PROVIDER_TIMEOUT',
    timeoutType,
  });
}
