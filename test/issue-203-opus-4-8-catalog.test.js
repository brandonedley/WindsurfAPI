import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, getModelInfo, listModels } from '../src/models.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';

// ---------------------------------------------------------------------------
// Issue #203 — "devin 软件上有 claude-opus-4-8，账号放到这里最高只能看到 4-7,
// 完全没有 opus-4-8 的模型". hiSandog asked to pin the -opus-4- / -opus-4-7 vs
// -opus-4-8 minimal scenario so a fix truly covers the path instead of just
// bypassing the current error.
//
// Root cause (per the maintainer's own reply): the reporter is on the *Cascade*
// channel, whose upstream GetCascadeModelConfigs hasn't opened 4-8 to their
// account tier — an entitlement wall, not a catalog gap. On the *DEVIN_CONNECT*
// (direct cloud) path opus-4-8 IS wired end to end and frame-verified. These
// tests lock in that both resolution layers expose opus-4-8 correctly so the
// only remaining variable is the account entitlement.
// ---------------------------------------------------------------------------

describe('issue #203 — opus-4-8 is fully wired in the static catalog', () => {
  const OPUS_48_ALIASES = [
    'claude-opus-4-8',
    'claude-opus-4.8',
    'claude-opus-4-8-medium',
    'claude-opus-4-8-thinking',
    'claude-opus-4.8-thinking',
    'opus-4-8',
    'opus-4.8',
  ];

  for (const alias of OPUS_48_ALIASES) {
    it(`resolves "${alias}" to the real claude-opus-4-8-medium catalog entry`, () => {
      const key = resolveModel(alias);
      const info = getModelInfo(key);
      assert.ok(info, `"${alias}" must resolve to a known catalog entry, not a silent passthrough`);
      assert.equal(info.modelUid, 'claude-opus-4-8-medium');
      assert.equal(info.provider, 'anthropic');
    });
  }

  it('exposes claude-opus-4-8-medium in /v1/models (the reporter\'s "完全没有 opus-4-8" claim)', () => {
    const ids = listModels().map((m) => m.id);
    assert.ok(
      ids.includes('claude-opus-4-8-medium'),
      'opus-4-8 must appear in the /v1/models catalog listing',
    );
  });

  it('maps opus-4-8 to the frame-verified DEVIN_CONNECT selector (the usable path)', () => {
    // This is the crux of "how a paid account actually gets opus-4-8": the
    // DEVIN_CONNECT resolver must map it to the frame-verified selector, mapped:true.
    const r = resolveConnectSelector('claude-opus-4-8');
    assert.equal(r.selector, 'claude-opus-4-8-medium');
    assert.equal(r.mapped, true);
    // The bare/normalized forms must not silently degrade to the free selector.
    for (const alias of ['claude-opus-4.8', 'opus-4-8', 'claude-opus-4-8-medium']) {
      assert.equal(resolveConnectSelector(alias).mapped, true, `${alias} must map, not degrade`);
    }
  });
});

describe('issue #203 — opus-4-7 still resolves (4-8 addition did not regress it)', () => {
  for (const alias of ['claude-opus-4-7', 'claude-opus-4.7', 'opus-4-7', 'opus-4.7']) {
    it(`resolves "${alias}" to claude-opus-4-7-medium`, () => {
      const info = getModelInfo(resolveModel(alias));
      assert.ok(info, `"${alias}" must resolve to a known catalog entry`);
      assert.equal(info.modelUid, 'claude-opus-4-7-medium');
    });
  }

  it('opus-4-7 and opus-4-8 are distinct catalog entries (no collision)', () => {
    const uid47 = getModelInfo(resolveModel('claude-opus-4-7')).modelUid;
    const uid48 = getModelInfo(resolveModel('claude-opus-4-8')).modelUid;
    assert.notEqual(uid47, uid48);
    assert.equal(uid47, 'claude-opus-4-7-medium');
    assert.equal(uid48, 'claude-opus-4-8-medium');
  });
});
