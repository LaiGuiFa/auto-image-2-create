import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KV_SELECTED_PROVIDER,
  getProviderApiKeyStorageKey,
  resolveSelectedProvider,
} from '../assets/js/provider-settings.js';
import { normalizeRuntimeConfig } from '../assets/js/runtime-config.js';

test('normalizeRuntimeConfig keeps public provider metadata and default selection', () => {
  assert.deepEqual(normalizeRuntimeConfig({
    defaultProviderId: 'alpha',
    providers: [
      { id: 'alpha', label: 'Alpha', supportsAsync: true },
      { id: 'beta', label: 'Beta', supportsAsync: false },
    ],
    deepseekConfigured: true,
    requestTimeoutMs: 123,
    uploadRetentionDays: 7,
  }), {
    defaultProviderId: 'alpha',
    providers: [
      { id: 'alpha', label: 'Alpha', supportsAsync: true },
      { id: 'beta', label: 'Beta', supportsAsync: false },
    ],
    deepseekConfigured: true,
    requestTimeoutMs: 123,
    uploadRetentionDays: 7,
  });
});

test('resolveSelectedProvider falls back to the default provider when persisted selection is invalid', () => {
  const provider = resolveSelectedProvider({
    providers: [
      { id: 'alpha', label: 'Alpha', supportsAsync: true },
      { id: 'beta', label: 'Beta', supportsAsync: false },
    ],
    defaultProviderId: 'beta',
    selectedProviderId: 'missing',
  });

  assert.deepEqual(provider, {
    id: 'beta',
    label: 'Beta',
    supportsAsync: false,
  });
});

test('provider settings helpers generate stable kv keys', () => {
  assert.equal(KV_SELECTED_PROVIDER, 'cnd_ai_selected_provider');
  assert.equal(getProviderApiKeyStorageKey('alpha'), 'cnd_ai_provider_key_alpha');
});
