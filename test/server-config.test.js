import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRuntimeConfig } from '../server/config.js';

test('parseRuntimeConfig requires explicit provider registry', () => {
  assert.throws(
    () => parseRuntimeConfig({}),
    /IMAGE_PROVIDERS_JSON/i,
  );
});

test('parseRuntimeConfig normalizes provider and deepseek env config', () => {
  const config = parseRuntimeConfig({
    IMAGE_PROVIDERS_JSON: JSON.stringify([
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
        supportsAsync: false,
      },
    ]),
    IMAGE_DEFAULT_PROVIDER_ID: 'beta',
    DEEPSEEK_API_KEY: 'secret',
    DEEPSEEK_MODEL: 'deepseek-chat',
    DEEPSEEK_URL: 'https://deepseek.example/chat',
    DEEPSEEK_POLISH_SYSTEM_PROMPT: 'polish this',
    REQUEST_TIMEOUT_MS: '1234',
    UPLOAD_RETENTION_DAYS: '9',
  });

  assert.equal(config.defaultProviderId, 'beta');
  assert.equal(config.requestTimeoutMs, 1234);
  assert.equal(config.uploadRetentionDays, 9);
  assert.equal(config.providers[0].baseUrl, 'https://alpha.example');
  assert.equal(config.providers[0].syncPath, '/sync');
  assert.equal(config.providers[0].pollPathBase, '/tasks/');
  assert.equal(config.deepseek.enabled, true);
  assert.equal(config.deepseek.url, 'https://deepseek.example/chat');
  assert.equal(config.deepseek.systemPrompt, 'polish this');
  assert.deepEqual(config.publicProviders[1], {
    id: 'beta',
    label: 'Beta',
    supportsAsync: false,
  });
});

test('parseRuntimeConfig rejects missing default provider id', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'alpha',
        label: 'Alpha',
        baseUrl: 'https://alpha.example',
        syncPath: '/sync',
        supportsAsync: false,
      }]),
    }),
    /IMAGE_DEFAULT_PROVIDER_ID/i,
  );
});

test('parseRuntimeConfig rejects invalid default provider id', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'missing',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'alpha',
        label: 'Alpha',
        baseUrl: 'https://alpha.example',
        syncPath: '/sync',
        supportsAsync: false,
      }]),
    }),
    /IMAGE_DEFAULT_PROVIDER_ID/i,
  );
});

test('parseRuntimeConfig rejects empty provider registry', () => {
  assert.throws(
    () => parseRuntimeConfig({ IMAGE_PROVIDERS_JSON: '' }),
    /IMAGE_PROVIDERS_JSON/i,
  );
});

test('parseRuntimeConfig rejects malformed provider json', () => {
  assert.throws(
    () => parseRuntimeConfig({ IMAGE_PROVIDERS_JSON: '{"bad":' }),
    /IMAGE_PROVIDERS_JSON/i,
  );
});

test('parseRuntimeConfig rejects provider entries with missing ids', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{ label: 'No Id', baseUrl: 'https://x.example', syncPath: '/sync' }]),
    }),
    /provider id/i,
  );
});

test('parseRuntimeConfig rejects duplicate provider ids', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'dup',
      IMAGE_PROVIDERS_JSON: JSON.stringify([
        { id: 'dup', label: 'One', baseUrl: 'https://a.example', syncPath: '/sync', supportsAsync: false },
        { id: 'dup', label: 'Two', baseUrl: 'https://b.example', syncPath: '/sync', supportsAsync: false },
      ]),
    }),
    /duplicate/i,
  );
});

test('parseRuntimeConfig rejects provider entries with missing baseUrl or syncPath', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'x',
        label: 'X',
        syncPath: '/sync',
        supportsAsync: false,
      }]),
    }),
    /baseUrl/i,
  );

  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'x',
        label: 'X',
        baseUrl: 'https://x.example',
        supportsAsync: false,
      }]),
    }),
    /syncPath/i,
  );
});

test('parseRuntimeConfig rejects providers with missing explicit supportsAsync field', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'x',
        label: 'X',
        baseUrl: 'https://x.example',
        syncPath: '/sync',
      }]),
    }),
    /supportsAsync/i,
  );
});

test('parseRuntimeConfig rejects async providers missing async paths', () => {
  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'x',
        label: 'X',
        baseUrl: 'https://x.example',
        syncPath: '/sync',
        supportsAsync: true,
        asyncPath: '',
        pollPathBase: '/tasks/',
      }]),
    }),
    /asyncPath/i,
  );

  assert.throws(
    () => parseRuntimeConfig({
      IMAGE_DEFAULT_PROVIDER_ID: 'x',
      IMAGE_PROVIDERS_JSON: JSON.stringify([{
        id: 'x',
        label: 'X',
        baseUrl: 'https://x.example',
        syncPath: '/sync',
        supportsAsync: true,
        asyncPath: '/async',
        pollPathBase: '',
      }]),
    }),
    /pollPathBase/i,
  );
});

test('parseRuntimeConfig treats deepseek as unconfigured when any required field is missing', () => {
  const baseEnv = {
    IMAGE_DEFAULT_PROVIDER_ID: 'alpha',
    IMAGE_PROVIDERS_JSON: JSON.stringify([{
      id: 'alpha',
      label: 'Alpha',
      baseUrl: 'https://alpha.example',
      syncPath: '/sync',
      supportsAsync: false,
    }]),
  };

  assert.equal(parseRuntimeConfig({
    ...baseEnv,
    DEEPSEEK_URL: 'https://deepseek.example/chat',
    DEEPSEEK_API_KEY: 'secret',
    DEEPSEEK_MODEL: 'deepseek-chat',
  }).deepseek.enabled, false);

  assert.equal(parseRuntimeConfig({
    ...baseEnv,
    DEEPSEEK_URL: 'https://deepseek.example/chat',
    DEEPSEEK_API_KEY: 'secret',
    DEEPSEEK_POLISH_SYSTEM_PROMPT: 'polish this',
  }).deepseek.enabled, false);
});
