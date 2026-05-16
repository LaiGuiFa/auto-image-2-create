import { UPSTREAM } from './config.js';

export function getProxyTarget(action) {
  if (action === 'sync') return UPSTREAM.sync;
  if (action === 'async') return UPSTREAM.async;
  throw new Error(`Unknown action: ${action}`);
}

export function buildPollUrl(taskId) {
  return `${UPSTREAM.pollBase}${encodeURIComponent(taskId)}`;
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
