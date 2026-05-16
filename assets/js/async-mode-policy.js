export function resolveAllowedAsyncMode(mode, asyncDisabled) {
  if (asyncDisabled && mode === 'async') return 'sync';
  return mode === 'async' ? 'async' : 'sync';
}

export function isAsyncModeDisabled(asyncDisabled) {
  return asyncDisabled === true;
}
