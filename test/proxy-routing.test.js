import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPollUrl, getProxyTarget, resolveProvider } from '../server/proxy.js';

const runtimeConfig = {
  defaultProviderId: 'alpha',
  providers: [
    {
      id: 'alpha',
      label: 'Alpha',
      baseUrl: 'https://alpha.example',
      syncPath: '/sync',
      asyncPath: '/async',
      pollPathBase: '/tasks/',
      supportsAsync: true,
    },
    {
      id: 'beta',
      label: 'Beta',
      baseUrl: 'https://beta.example',
      syncPath: '/sync',
      asyncPath: '/async',
      pollPathBase: '/tasks/',
      supportsAsync: false,
    },
  ],
};

test('resolveProvider falls back to the default provider', () => {
  assert.equal(resolveProvider(runtimeConfig).id, 'alpha');
  assert.equal(resolveProvider(runtimeConfig, 'beta').id, 'beta');
});

test('resolveProvider returns a readable Chinese error for unknown providers', () => {
  assert.throws(
    () => resolveProvider(runtimeConfig, 'missing'),
    /missing/,
  );
});

test('getProxyTarget and buildPollUrl derive provider-aware upstream urls', () => {
  const provider = runtimeConfig.providers[0];
  assert.equal(getProxyTarget(provider, 'sync'), 'https://alpha.example/sync');
  assert.equal(getProxyTarget(provider, 'async'), 'https://alpha.example/async');
  assert.equal(buildPollUrl(provider, 'task 1'), 'https://alpha.example/tasks/task%201');
});
