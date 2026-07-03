// Quota governor — client-side model of the upstream ACCOUNT message rate
// limit. Reconciling the proxy logs against the Hermes gateway's timestamped
// session logs proved the limit is account-level (every model's lockout —
// glm-5.2 and kimi-k2-6 — counted down to the SAME unlock instant) on a fixed
// ~1-hour window (onset + 3600s = unlock), NOT a per-model 3h window. The
// server never reports this limit via any status API (getUserStatus covers
// only the daily/weekly CREDIT quota), so the only way to respect it is to
// count our own sends per account (across all models) and refuse locally
// before the hard 1h lockout. Flag-gated: WINDSURFAPI_QUOTA_GOVERNOR=1, OFF.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_WINDOW_MS,
  ACCOUNT_CAP_DEFAULT,
  recordUpstreamSend,
  onRateLimitLockout,
  shouldSoftLimitAccount,
  getQuotaWindowSummary,
  _resetForTests,
} from '../src/quota-window.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const ACCT = 'devin-tok-abcdef';
const GLM = 'glm-5.2';
const KIMI = 'kimi-k2-6';
const T0 = 1_700_000_000_000; // deterministic base timestamp

beforeEach(() => {
  _resetForTests();
  delete process.env.WINDSURFAPI_QUOTA_GOVERNOR;
  delete process.env.WINDSURFAPI_QUOTA_SOFT_PCT;
  delete process.env.WINDSURFAPI_QUOTA_ACCOUNT_CAP;
  delete process.env.WINDSURFAPI_QUOTA_WINDOW_HOURS;
});

const acctWindow = () => getQuotaWindowSummary().find(w => w.accountId === ACCT.slice(0, 8));

// ─── window length ──────────────────────────────────────────────

// Multi-day log reconciliation (37 lockout episodes; 36/37 fresh marks were
// "Resets in: 3h0m0s"; a 71-min countdown converged on one unlock instant
// within 18s) established a fixed ~3-HOUR account window. The earlier "1h"
// reading was the tail of a single lock mistaken for its onset.
test('the counting window defaults to three hours (the measured lockout period)', () => {
  assert.equal(QUOTA_WINDOW_MS, 3 * 60 * 60 * 1000);
});

test('WINDSURFAPI_QUOTA_WINDOW_HOURS overrides the window length', () => {
  process.env.WINDSURFAPI_QUOTA_WINDOW_HOURS = '2';
  recordUpstreamSend(ACCT, GLM, T0);
  assert.equal(acctWindow().windowEndsAt, T0 + 2 * 60 * 60 * 1000, 'window ends 2h out per override');
});

// ─── account-wide counting (across models) ──────────────────────

test('sends across DIFFERENT models count into one shared account window', () => {
  recordUpstreamSend(ACCT, GLM, T0);
  recordUpstreamSend(ACCT, KIMI, T0 + 1000);
  recordUpstreamSend(ACCT, GLM, T0 + 2000);
  const w = acctWindow();
  assert.equal(w.count, 3, 'all three count into the account window regardless of model');
  assert.deepEqual(w.byModel, { [GLM]: 2, [KIMI]: 1 }, 'per-model breakdown preserved for display');
});

test('the window rolls after the window length elapses', () => {
  recordUpstreamSend(ACCT, GLM, T0);
  recordUpstreamSend(ACCT, GLM, T0 + 1000);
  assert.equal(acctWindow().count, 2);
  recordUpstreamSend(ACCT, GLM, T0 + QUOTA_WINDOW_MS + 1000);
  assert.equal(acctWindow().count, 1, 'past the window a fresh one starts');
});

test('separate accounts get separate windows', () => {
  recordUpstreamSend(ACCT, GLM, T0);
  recordUpstreamSend('other-acct-xyz', GLM, T0);
  assert.equal(getQuotaWindowSummary().length, 2);
});

// ─── cap learning (account-level) ───────────────────────────────

test('a lockout learns the ACCOUNT cap from the account-wide count', () => {
  // Mixed-model traffic: 25 glm + 15 kimi = 40 account-wide before the lock.
  for (let i = 0; i < 25; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  for (let i = 0; i < 15; i++) recordUpstreamSend(ACCT, KIMI, T0 + 25 + i);
  onRateLimitLockout(ACCT, GLM, QUOTA_WINDOW_MS, T0 + 100);
  const w = acctWindow();
  assert.equal(w.capEstimate, 40, 'cap is the account total, not the per-model count');
  assert.equal(w.lockouts, 1);
});

test('a lockout at a tiny local count does NOT learn a cap (devin-CLI burn guard)', () => {
  // The devin CLI shares the account key. A lockout after only a few local
  // sends means external traffic burned the window — our count is garbage.
  for (let i = 0; i < 3; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  onRateLimitLockout(ACCT, GLM, 60_000, T0 + 100);
  assert.equal(acctWindow().learnedCaps.length, 0, 'no cap learned from count=3');
  assert.equal(acctWindow().lockouts, 1, 'lockout still counted');
});

test('capEstimate is the MOST conservative (min) of the learned caps', () => {
  // Devin overhead varies, so proxy-visible lockout points vary. To avoid
  // re-locking, threshold off the lowest cliff seen, not the highest.
  for (let round = 0; round < 3; round++) {
    const base = T0 + round * (QUOTA_WINDOW_MS + 10_000);
    const n = [40, 20, 60][round];
    for (let i = 0; i < n; i++) recordUpstreamSend(ACCT, GLM, base + i);
    onRateLimitLockout(ACCT, GLM, 1000, base + n);
  }
  const w = acctWindow();
  assert.deepEqual(w.learnedCaps, [40, 20, 60]);
  assert.equal(w.capEstimate, 20, 'min of learned caps — conservative');
});

test('a lockout anchors the window end to the upstream reset time', () => {
  recordUpstreamSend(ACCT, GLM, T0);
  const resetMs = 51 * 60 * 1000 + 24 * 1000; // "Resets in: 51m24s"
  onRateLimitLockout(ACCT, GLM, resetMs, T0 + 5000);
  assert.equal(acctWindow().windowEndsAt, T0 + 5000 + resetMs);
});

// ─── soft-limit decision (account-level, model-agnostic) ────────

test('flag off → never limits', () => {
  for (let i = 0; i < 500; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  assert.equal(shouldSoftLimitAccount(T0 + 1000).limited, false);
});

test('with no learned cap, soft-limit fires at 85% of the DEFAULT account cap', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  const threshold = Math.ceil(ACCOUNT_CAP_DEFAULT * 0.85);
  for (let i = 0; i < threshold - 1; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  assert.equal(shouldSoftLimitAccount(T0 + 1000).limited, false, 'just under threshold');
  recordUpstreamSend(ACCT, GLM, T0 + threshold);
  const d = shouldSoftLimitAccount(T0 + threshold + 1);
  assert.equal(d.limited, true, 'at threshold → limited');
  assert.ok(d.retryAfterMs > 0);
});

test('a learned cap overrides the default', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  // learn cap=20 in a prior window
  for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  onRateLimitLockout(ACCT, GLM, 1000, T0 + 20); // 1ms reset → window over
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000; // fresh window
  for (let i = 0; i < 16; i++) recordUpstreamSend(ACCT, GLM, base2 + i);
  assert.equal(shouldSoftLimitAccount(base2 + 500).limited, false, '16/20 under 85%');
  recordUpstreamSend(ACCT, GLM, base2 + 600); // 17th = ceil(20*0.85)
  assert.equal(shouldSoftLimitAccount(base2 + 700).limited, true, '17/20 hits 85%');
});

test('the limit is account-level: kimi traffic trips a cap learned via glm', () => {
  // The whole point of the rework. Learn the account cap from a glm lockout,
  // then burn the fresh window entirely on KIMI — it must still trip, because
  // the budget is shared. (Under the old per-model design, kimi had its own
  // starved window and this cross-model coupling did not exist.)
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  onRateLimitLockout(ACCT, GLM, 1000, T0 + 20);
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 17; i++) recordUpstreamSend(ACCT, KIMI, base2 + i); // all kimi
  assert.equal(shouldSoftLimitAccount(base2 + 700).limited, true, 'kimi burn trips the shared account cap');
});

test('WINDSURFAPI_QUOTA_SOFT_PCT override is respected', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  process.env.WINDSURFAPI_QUOTA_SOFT_PCT = '50';
  for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  onRateLimitLockout(ACCT, GLM, 1000, T0 + 20); // cap=20 → threshold ceil(20*0.5)=10
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 10; i++) recordUpstreamSend(ACCT, GLM, base2 + i);
  assert.equal(shouldSoftLimitAccount(base2 + 500).limited, true);
});

test('WINDSURFAPI_QUOTA_ACCOUNT_CAP override changes the default threshold', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  process.env.WINDSURFAPI_QUOTA_ACCOUNT_CAP = '10';
  for (let i = 0; i < 8; i++) recordUpstreamSend(ACCT, GLM, T0 + i); // ceil(10*0.85)=9
  assert.equal(shouldSoftLimitAccount(T0 + 100).limited, false, '8/10 under 85%');
  recordUpstreamSend(ACCT, GLM, T0 + 9);
  assert.equal(shouldSoftLimitAccount(T0 + 200).limited, true, '9/10 hits 85%');
});

test('an expired window never soft-limits (fresh budget)', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  for (let i = 0; i < 200; i++) recordUpstreamSend(ACCT, GLM, T0 + i);
  assert.equal(shouldSoftLimitAccount(T0 + QUOTA_WINDOW_MS + 5000).limited, false);
});

// ─── gate integration (chat.js native route) ────────────────────

const tools = [
  { type: 'function', function: { name: 'exec', description: 'run', parameters: { type: 'object', properties: {} } } },
];

test('governor gate returns 429 before the native transport is called', async () => {
  const prevTools = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  process.env.WINDSURFAPI_QUOTA_ACCOUNT_CAP = '20';
  try {
    const now = Date.now();
    // Burn to the 85% threshold (ceil(20*0.85)=17) in a live window.
    for (let i = 0; i < 17; i++) recordUpstreamSend('devin-tok', GLM, now - 1000 + i);

    let transportCalled = false;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => { transportCalled = true; return { text: 'x', stopReason: 2, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: GLM, messages: [{ role: 'user', content: 'x' }], tools },
      ctx,
    );
    assert.equal(res.status, 429, 'soft limit surfaces as 429');
    assert.equal(res.body.error.type, 'rate_limit_exceeded');
    assert.ok(res.headers['Retry-After'], 'Retry-After set');
    assert.ok(res.body.error.retry_after_ms > 0);
    assert.equal(transportCalled, false, 'no upstream call was spent');
  } finally {
    if (prevTools !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prevTools;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});

test('flag off → gate is inert and the native transport runs', async () => {
  const prevTools = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  process.env.WINDSURFAPI_QUOTA_ACCOUNT_CAP = '20';
  try {
    const now = Date.now();
    for (let i = 0; i < 40; i++) recordUpstreamSend('devin-tok', GLM, now - 1000 + i);

    let transportCalled = false;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => { transportCalled = true; return { text: 'x', stopReason: 2, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: GLM, messages: [{ role: 'user', content: 'x' }], tools },
      ctx,
    );
    assert.equal(res.status, 200);
    assert.equal(transportCalled, true);
  } finally {
    if (prevTools !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prevTools;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});
