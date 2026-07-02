// @ts-nocheck
const DEFAULT_POLICY = Object.freeze({
  adapterMode: 'conservative',
  preferredBackend: 'cascade_emulation',
  preferredDialect: 'openai_json_xml',
  maxToolsFull: 20,
  maxLastUserCharsWithFullTools: 64_000,
  maxTotalCharsWithTools: 180_000,
  maxRecoveryAttempts: 1,
  allowGenericNarrativeRecovery: false,
  allowNativeBridge: false,
});

function normalizeModel(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

export function getHermesDevinModelPolicy(modelKey = '', provider = null) {
  const model = normalizeModel(modelKey);
  const providerKey = normalizeModel(provider);
  const base = { ...DEFAULT_POLICY, modelKey: model, provider: providerKey || null };

  if (/^(?:glm|zai|zhipu)/.test(model) || providerKey === 'zhipu') {
    return {
      ...base,
      adapterMode: 'fragile_tools',
      preferredBackend: 'cascade_emulation',
      preferredDialect: 'glm47',
      maxToolsFull: 12,
      maxLastUserCharsWithFullTools: 80_000,
      maxTotalCharsWithTools: 160_000,
      maxRecoveryAttempts: 1,
      allowGenericNarrativeRecovery: false,
      allowNativeBridge: false,
    };
  }

  if (/^(?:swe-|devin|adaptive)/.test(model) || providerKey === 'devin') {
    return {
      ...base,
      adapterMode: 'devin_acp_preferred',
      preferredBackend: 'devin_acp',
      preferredDialect: 'acp',
      maxToolsFull: 32,
      maxLastUserCharsWithFullTools: 180_000,
      maxTotalCharsWithTools: 350_000,
      allowNativeBridge: true,
    };
  }

  if (/^(?:gpt-|openai)/.test(model)) {
    return {
      ...base,
      adapterMode: 'gpt_native_capable',
      preferredBackend: 'cascade_emulation',
      preferredDialect: 'gpt_native',
      maxToolsFull: 32,
      maxLastUserCharsWithFullTools: 128_000,
      maxTotalCharsWithTools: 260_000,
      allowNativeBridge: true,
    };
  }

  if (/^(?:kimi|moonshot)/.test(model) || providerKey === 'moonshot') {
    return {
      ...base,
      adapterMode: 'constrained_tools',
      preferredBackend: 'cascade_emulation',
      preferredDialect: 'kimi_k2',
      maxToolsFull: 20,
      maxLastUserCharsWithFullTools: 100_000,
      maxTotalCharsWithTools: 220_000,
      allowNativeBridge: false,
    };
  }

  return base;
}
