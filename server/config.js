import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');
export const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

export const ROUTES = {
  upload: '/api/upload',
  runtimeConfig: '/api/runtime-config',
  imageSync: '/api/image/sync',
  imageAsync: '/api/image/async',
  imagePoll: '/api/image/poll',
  polish: '/api/polish',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function parseRuntimeConfig(env = process.env) {
  const providers = parseProviders(env);
  const defaultProviderId = String(env.IMAGE_DEFAULT_PROVIDER_ID || '').trim();
  if (!defaultProviderId) {
    throw new Error('IMAGE_DEFAULT_PROVIDER_ID is required');
  }
  if (!providers.some((provider) => provider.id === defaultProviderId)) {
    throw new Error('IMAGE_DEFAULT_PROVIDER_ID must match a configured provider id');
  }

  const deepseekApiKey = String(env.DEEPSEEK_API_KEY || '').trim();
  const deepseekUrl = normalizeDeepseekUrl(String(env.DEEPSEEK_URL || '').trim());
  const deepseekModel = String(env.DEEPSEEK_MODEL || '').trim();
  const deepseekSystemPrompt = String(env.DEEPSEEK_POLISH_SYSTEM_PROMPT || '').trim();

  return {
    providers,
    publicProviders: providers.map(toPublicProvider),
    defaultProviderId,
    deepseek: {
      enabled: Boolean(deepseekUrl && deepseekApiKey && deepseekModel && deepseekSystemPrompt),
      apiKey: deepseekApiKey,
      url: deepseekUrl,
      model: deepseekModel,
      systemPrompt: deepseekSystemPrompt,
    },
    requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, 300000),
    uploadRetentionDays: parsePositiveInt(env.UPLOAD_RETENTION_DAYS, 7),
  };
}

function parseProviders(env) {
  const raw = typeof env.IMAGE_PROVIDERS_JSON === 'string'
    ? env.IMAGE_PROVIDERS_JSON.trim()
    : '';
  if (!raw) {
    throw new Error('IMAGE_PROVIDERS_JSON is required');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('IMAGE_PROVIDERS_JSON is malformed');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('IMAGE_PROVIDERS_JSON must be a non-empty array');
  }

  const providers = parsed.map(normalizeProvider);
  const ids = new Set();
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    ids.add(provider.id);
  }
  return providers;
}

function normalizeProvider(provider, index = 0) {
  const id = String(provider?.id || '').trim();
  if (!id) {
    throw new Error(`Image provider id is required at index ${index}`);
  }
  const label = String(provider?.label || id).trim();
  const baseUrl = String(provider?.baseUrl || '').trim().replace(/\/+$/, '');
  const syncPath = normalizePathValue(provider?.syncPath);
  const editPath = normalizePathValue(provider?.editPath);
  const asyncPath = normalizePathValue(provider?.asyncPath);
  const pollPathBase = normalizePathValue(provider?.pollPathBase);
  if (typeof provider?.supportsAsync !== 'boolean') {
    throw new Error(`Image provider "${id}" supportsAsync must be explicitly set`);
  }
  const supportsAsync = provider.supportsAsync;

  if (!baseUrl) {
    throw new Error(`Image provider "${id}" baseUrl is required`);
  }
  if (!syncPath) {
    throw new Error(`Image provider "${id}" syncPath is required`);
  }
  if (supportsAsync && !asyncPath) {
    throw new Error(`Image provider "${id}" asyncPath is required when supportsAsync is true`);
  }
  if (supportsAsync && !pollPathBase) {
    throw new Error(`Image provider "${id}" pollPathBase is required when supportsAsync is true`);
  }

  return {
    id,
    label,
    baseUrl,
    syncPath,
    editPath,
    asyncPath,
    pollPathBase,
    supportsAsync,
  };
}

function toPublicProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    supportsAsync: provider.supportsAsync,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePathValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeDeepseekUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/^https?:\/\/api\.deepseek\.com$/i.test(raw)) {
    return `${raw}/chat/completions`;
  }
  return raw;
}
