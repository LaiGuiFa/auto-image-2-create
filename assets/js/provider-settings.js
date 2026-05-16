import { getProviderById } from './runtime-config.js';

export const KV_SELECTED_PROVIDER = 'cnd_ai_selected_provider';

export function getProviderApiKeyStorageKey(providerId) {
  return `cnd_ai_provider_key_${String(providerId || '').trim()}`;
}

export function resolveSelectedProvider({ providers, defaultProviderId, selectedProviderId }) {
  return getProviderById(providers, selectedProviderId)
    || getProviderById(providers, defaultProviderId)
    || (Array.isArray(providers) && providers[0])
    || null;
}
