const FALLBACK_PROVIDER = Object.freeze({
  id: 'cnd',
  label: 'Image API',
  supportsAsync: true,
});

function normalizeProvider(provider) {
  const id = String(provider?.id || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(provider?.label || id).trim() || id,
    supportsAsync: provider?.supportsAsync !== false,
  };
}

export function normalizeRuntimeConfig(payload) {
  const providers = (Array.isArray(payload?.providers) ? payload.providers : [])
    .map(normalizeProvider)
    .filter(Boolean);
  const fallbackProviders = providers.length ? providers : [FALLBACK_PROVIDER];
  const requestedDefault = String(payload?.defaultProviderId || '').trim();
  const defaultProviderId = fallbackProviders.some(provider => provider.id === requestedDefault)
    ? requestedDefault
    : fallbackProviders[0].id;

  return {
    defaultProviderId,
    providers: fallbackProviders,
    deepseekConfigured: payload?.deepseekConfigured === true,
    requestTimeoutMs: Number(payload?.requestTimeoutMs) || 0,
    uploadRetentionDays: Number(payload?.uploadRetentionDays) || 0,
  };
}

export function getProviderById(providers, providerId) {
  const wanted = String(providerId || '').trim();
  return (Array.isArray(providers) ? providers : []).find(provider => provider.id === wanted) || null;
}
