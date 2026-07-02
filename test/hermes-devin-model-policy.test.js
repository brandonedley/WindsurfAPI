import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getHermesDevinModelPolicy } from '../src/hermes-devin/model-policy.js';

describe('Hermes Devin model policy', () => {
  it('puts GLM models in fragile tool compatibility mode', () => {
    const policy = getHermesDevinModelPolicy('glm-5.2', 'zhipu');
    assert.equal(policy.adapterMode, 'fragile_tools');
    assert.equal(policy.maxRecoveryAttempts, 1);
    assert.equal(policy.allowGenericNarrativeRecovery, false);
    assert.equal(policy.allowNativeBridge, false);
    assert.ok(policy.maxLastUserCharsWithFullTools < 133057);
  });

  it('puts SWE/Devin-native models on ACP-preferred path', () => {
    const policy = getHermesDevinModelPolicy('swe-1.6-fast', 'devin');
    assert.equal(policy.adapterMode, 'devin_acp_preferred');
    assert.equal(policy.allowNativeBridge, true);
    assert.equal(policy.preferredBackend, 'devin_acp');
  });

  it('keeps unknown models conservative', () => {
    const policy = getHermesDevinModelPolicy('unknown-model', null);
    assert.equal(policy.adapterMode, 'conservative');
    assert.equal(policy.maxRecoveryAttempts, 1);
    assert.equal(policy.allowGenericNarrativeRecovery, false);
  });
});
