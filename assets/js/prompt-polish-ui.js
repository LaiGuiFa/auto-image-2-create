import { normalizePolishText } from './prompt-polish.js';

export function buildPolishRequest(text) {
  return {
    text: normalizePolishText(text),
  };
}

export function readPolishResponseText(payload) {
  const text = normalizePolishText(payload?.text || '');
  if (!text) throw new Error('润色结果为空');
  return text;
}

export function getPolishButtonLabel(loading) {
  return loading ? '润色中...' : 'ai润色';
}

export function getPolishDisabledState({ loading }) {
  return loading === true;
}
