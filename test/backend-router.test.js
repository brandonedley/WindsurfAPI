import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBackend, usesCascadeFlow, BACKEND } from '../src/backend-router.js';

// Behaviour-preserving decision table. These cases mirror the inline routing
// logic in handlers/chat.js (isSpecialAgentModelInfo → special-agent, then
// useCascade = !!(modelUid || enumValue), else legacy). If any of these change
// the router has diverged from the legacy behaviour P1 promised to preserve.

describe('backend-router selectBackend — behaviour parity with legacy', () => {
  it('special_agent backend + default mode → devin-print', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: {} });
    assert.equal(sel.backend, BACKEND.DEVIN_PRINT);
    assert.equal(sel.flow, 'special_agent');
  });

  it('special_agent backend + DEVIN_CLI_MODE=acp → devin-acp', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: { DEVIN_CLI_MODE: 'acp' } });
    assert.equal(sel.backend, BACKEND.DEVIN_ACP);
    assert.equal(sel.flow, 'special_agent');
  });

  it('special_agent wins even when a modelUid is also present', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent', modelUid: 'MODEL_X' }, env: {} });
    assert.equal(sel.flow, 'special_agent');
  });

  it('modelUid present → cascade', () => {
    const sel = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_SONNET' }, env: {} });
    assert.equal(sel.backend, BACKEND.CASCADE);
    assert.equal(sel.flow, 'cascade');
    assert.equal(sel.reason, 'modelUid');
    assert.ok(usesCascadeFlow(sel));
  });

  it('enumValue > 0 (no uid) → cascade', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 166 }, env: {} });
    assert.equal(sel.backend, BACKEND.CASCADE);
    assert.equal(sel.reason, 'enumValue');
    assert.ok(usesCascadeFlow(sel));
  });

  it('no uid and no enum → legacy', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 0 }, env: {} });
    assert.equal(sel.backend, BACKEND.LEGACY);
    assert.equal(sel.flow, 'legacy');
    assert.equal(usesCascadeFlow(sel), false);
  });

  it('null modelInfo → legacy (defensive)', () => {
    const sel = selectBackend({ modelInfo: null, env: {} });
    assert.equal(sel.backend, BACKEND.LEGACY);
    assert.equal(sel.flow, 'legacy');
  });

  it('uses process.env by default (no env arg)', () => {
    // Smoke: must not throw and must return a known backend.
    const sel = selectBackend({ modelInfo: { modelUid: 'X' } });
    assert.ok(Object.values(BACKEND).includes(sel.backend));
  });

  it('DEVIN_REST constant exists but is never auto-selected in P1', () => {
    // P1 must not route anything to devin-rest yet.
    const cases = [
      { backend: 'special_agent' },
      { modelUid: 'X' },
      { enumValue: 5 },
      { enumValue: 0 },
      null,
    ];
    for (const modelInfo of cases) {
      const sel = selectBackend({ modelInfo, env: {} });
      assert.notEqual(sel.backend, BACKEND.DEVIN_REST);
    }
  });
});

// DEVIN_ONLY: Cascade retired — every request is forced onto Devin regardless
// of the model. This is the "Devin is the only core" kill-switch.
describe('backend-router selectBackend — DEVIN_ONLY (Cascade retired)', () => {
  it('forces a cascade model (claude) onto Devin when DEVIN_ONLY=1', () => {
    const sel = selectBackend({
      modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET', enumValue: 200 },
      env: { DEVIN_ONLY: '1' },
    });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
    assert.equal(sel.backend, BACKEND.DEVIN_PRINT); // default sub-mode
    assert.ok(!usesCascadeFlow(sel), 'no longer a cascade flow');
  });

  it('honours DEVIN_CLI_MODE=acp under DEVIN_ONLY', () => {
    const sel = selectBackend({
      modelInfo: { modelUid: 'MODEL_GPT_5' },
      env: { DEVIN_ONLY: '1', DEVIN_CLI_MODE: 'acp' },
    });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.backend, BACKEND.DEVIN_ACP);
  });

  it('forces even a legacy (no uid, no enum) model onto Devin', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 0 }, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('forces null modelInfo onto Devin (defensive)', () => {
    const sel = selectBackend({ modelInfo: null, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('DEVIN_ONLY wins over a special_agent model too (same flow, devin_only reason)', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('DEVIN_ONLY=0 / unset leaves legacy routing intact (cascade still selected)', () => {
    const off = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' }, env: { DEVIN_ONLY: '0' } });
    assert.equal(off.flow, 'cascade');
    const unset = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' }, env: {} });
    assert.equal(unset.flow, 'cascade');
  });

  it('only the exact value "1" enables DEVIN_ONLY (truthy-string guard)', () => {
    for (const v of ['true', 'yes', '2', 'on', ' ']) {
      const sel = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_ONLY: v } });
      assert.equal(sel.flow, 'cascade', `DEVIN_ONLY=${JSON.stringify(v)} must NOT enable`);
    }
    // surrounding whitespace around "1" is tolerated
    const padded = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_ONLY: ' 1 ' } });
    assert.equal(padded.flow, 'special_agent');
  });
});

// ─── GETCHATMESSAGE backend (native tool transport) ────────────────
// Flag-on + cascade-uid model + tools[] + catalog tool support → the cloud
// ApiServerService/GetChatMessage transport. This is the DEVIN_ONLY known-gap
// fix: GetChatMessage carries chat_model_uid (true model selection) where the
// ACP path only passes the model name as a prompt hint.

describe('backend-router selectBackend — GETCHATMESSAGE gating', () => {
  const glm = { modelUid: 'glm-5-2' };
  const tools = [{ type: 'function', function: { name: 'exec' } }];
  const flagOn = { WINDSURFAPI_GETCHATMESSAGE_TOOLS: '1' };

  it('flag + uid + tools + support → getchatmessage-native', () => {
    const sel = selectBackend({ modelInfo: glm, tools, modelSupportsTools: true, env: flagOn });
    assert.equal(sel.backend, BACKEND.GETCHATMESSAGE);
    assert.equal(sel.flow, 'getchatmessage');
    assert.equal(usesCascadeFlow(sel), false);
  });

  it('flag off → cascade (legacy parity preserved)', () => {
    const sel = selectBackend({ modelInfo: glm, tools, modelSupportsTools: true, env: {} });
    assert.equal(sel.backend, BACKEND.CASCADE);
  });

  it('no tools[] → cascade even with the flag on', () => {
    for (const t of [null, undefined, []]) {
      const sel = selectBackend({ modelInfo: glm, tools: t, modelSupportsTools: true, env: flagOn });
      assert.equal(sel.backend, BACKEND.CASCADE, `tools=${JSON.stringify(t)}`);
    }
  });

  it('catalog says no tool support → cascade even with the flag on', () => {
    const sel = selectBackend({ modelInfo: glm, tools, modelSupportsTools: false, env: flagOn });
    assert.equal(sel.backend, BACKEND.CASCADE);
  });

  it('wins over DEVIN_ONLY (true model selection beats the prompt-hint gap)', () => {
    const sel = selectBackend({
      modelInfo: glm, tools, modelSupportsTools: true,
      env: { ...flagOn, DEVIN_ONLY: '1' },
    });
    assert.equal(sel.backend, BACKEND.GETCHATMESSAGE);
  });

  it('special_agent models are never routed to getchatmessage', () => {
    const sel = selectBackend({
      modelInfo: { backend: 'special_agent', modelUid: 'swe-1.6' },
      tools, modelSupportsTools: true, env: flagOn,
    });
    assert.equal(sel.flow, 'special_agent');
  });

  it('DEVIN_ONLY still forces devin for non-tool requests when the flag is on', () => {
    const sel = selectBackend({ modelInfo: glm, tools: [], modelSupportsTools: true, env: { ...flagOn, DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });
});
