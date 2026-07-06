import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectSelector, FREE_TIER_SELECTOR } from '../src/devin-connect-models.js';

describe('resolveConnectSelector', () => {
  it('resolves the free-tier swe selector (dash and dot forms)', () => {
    assert.deepEqual(resolveConnectSelector('swe-1-6-slow'), { selector: 'swe-1-6-slow', mapped: true });
    assert.deepEqual(resolveConnectSelector('swe-1.6-slow'), { selector: 'swe-1-6-slow', mapped: true });
  });

  it('maps claude friendly names to their captured upstream selectors', () => {
    assert.equal(resolveConnectSelector('claude-opus-4.8').selector, 'claude-opus-4-8-medium');
    // Dashed bare form is a real catalog selector (base model) → resolves to itself;
    // the dotted family alias keeps the curated -thinking default.
    assert.equal(resolveConnectSelector('claude-sonnet-4-6').selector, 'claude-sonnet-4-6');
    assert.equal(resolveConnectSelector('claude-sonnet-4.6').selector, 'claude-sonnet-4-6-thinking');
    assert.equal(resolveConnectSelector('claude-sonnet-4.5').selector, 'MODEL_PRIVATE_2');
    assert.equal(resolveConnectSelector('claude-haiku-4-5').selector, 'MODEL_PRIVATE_11');
  });

  it('maps gpt and gemini families', () => {
    assert.equal(resolveConnectSelector('gpt-5-2-high').selector, 'MODEL_GPT_5_2_HIGH');
    assert.equal(resolveConnectSelector('gemini-3-flash').selector, 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM');
  });

  it('is case-insensitive and strips a provider prefix', () => {
    assert.equal(resolveConnectSelector('Claude-Opus-4.8').selector, 'claude-opus-4-8-medium');
    assert.equal(resolveConnectSelector('anthropic/claude-sonnet-4-5').selector, 'MODEL_PRIVATE_2');
  });

  it('passes enum-form selectors through verbatim', () => {
    assert.deepEqual(resolveConnectSelector('MODEL_CLAUDE_4_5_OPUS_THINKING'),
      { selector: 'MODEL_CLAUDE_4_5_OPUS_THINKING', mapped: true });
  });

  it('degrades unknown names to the free-tier selector (mapped:false)', () => {
    assert.deepEqual(resolveConnectSelector('gpt-9-ultra'), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(''), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(null), { selector: FREE_TIER_SELECTOR, mapped: false });
  });
});
