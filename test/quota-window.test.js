// Quota governor — client-side model of the upstream per-account, per-model
// MESSAGE rate limit (fixed ~3h window, revealed only by the lockout trailer
// "Reached message rate limit ... Resets in: 3h0m0s"). The server never
// reports this limit via any status API (getUserStatus covers only the
// daily/weekly CREDIT quota), so the only way to respect it is to count our
// own sends and learn each model's cap empirically from where past lockouts
// landed. Flag-gated: WINDSURFAPI_QUOTA_GOVERNOR=1, default OFF.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_WINDOW_MS,
  recordUpstreamSend,
  onRateLimitLockout,
  shouldSoftLimitModel,
  getQuotaWindowSummary,
  _resetForTests,
} from '../src/quota-window.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

const ACCT = 'devin-tok-abcdef';
const MODEL = 'glm-5.2';
const T0 = 1_700_000_000_000; // deterministic base timestamp

beforeEach(() => {
  _resetForTests();
  delete process.env.WINDSURFAPI_QUOTA_GOVERNOR;
  delete process.env.WINDSURFAPI_QUOTA_SOFT_PCT;
});

// ─── window counting ────────────────────────────────────────────

test('recordUpstreamSend counts within a window and rolls after expiry', () => {
  recordUpstreamSend(ACCT, MODEL, T0);
  recordUpstreamSend(ACCT, MODEL, T0 + 1000);
  let s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.count, 2);

  // Past the window end the counter starts a fresh window.
  recordUpstreamSend(ACCT, MODEL, T0 + QUOTA_WINDOW_MS + 1000);
  s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.count, 1, 'window rolled');
});

test('windows are tracked per account+model pair', () => {
  recordUpstreamSend(ACCT, MODEL, T0);
  recordUpstreamSend('other-acct', MODEL, T0);
  recordUpstreamSend(ACCT, 'kimi-k2-6', T0);
  const summary = getQuotaWindowSummary();
  assert.equal(summary.length, 3);
  for (const w of summary) assert.equal(w.count, 1);
});

// ─── cap learning ───────────────────────────────────────────────

test('lockout learns the cap from the window count (>=10 guard)', () => {
  for (let i = 0; i < 40; i++) recordUpstreamSend(ACCT, MODEL, T0 + i);
  onRateLimitLockout(ACCT, MODEL, 3 * 60 * 60 * 1000, T0 + 100);
  const s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.capEstimate, 40);
  assert.equal(s.lockouts, 1);
});

test('lockout with a small count does NOT learn a cap (external burn guard)', () => {
  // The same account key is shared with the devin CLI: if something outside
  // the proxy exhausted the window, our local count is garbage — never learn
  // a cap below 10.
  for (let i = 0; i < 3; i++) recordUpstreamSend(ACCT, MODEL, T0 + i);
  onRateLimitLockout(ACCT, MODEL, 60_000, T0 + 100);
  const s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.capEstimate, null, 'no cap learned from count=3');
  assert.equal(s.lockouts, 1, 'lockout still counted');
});

test('learnedCaps keeps the last 5 and capEstimate is the max', () => {
  for (let round = 0; round < 7; round++) {
    const base = T0 + round * (QUOTA_WINDOW_MS + 10_000);
    const n = 10 + round; // 10, 11, ... 16
    for (let i = 0; i < n; i++) recordUpstreamSend(ACCT, MODEL, base + i);
    onRateLimitLockout(ACCT, MODEL, 60_000, base + n);
  }
  const s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.learnedCaps.length, 5, 'ring of 5');
  assert.deepEqual(s.learnedCaps, [12, 13, 14, 15, 16]);
  assert.equal(s.capEstimate, 16);
});

test('lockout anchors the window end to the upstream reset time', () => {
  recordUpstreamSend(ACCT, MODEL, T0);
  const resetMs = 41 * 60 * 1000; // "Resets in: 41m"
  onRateLimitLockout(ACCT, MODEL, resetMs, T0 + 5000);
  const s = getQuotaWindowSummary().find(w => w.modelKey === MODEL);
  assert.equal(s.windowEndsAt, T0 + 5000 + resetMs);
});

// ─── soft limit decision ────────────────────────────────────────

function learnCap(cap, base = T0) {
  for (let i = 0; i < cap; i++) recordUpstreamSend(ACCT, MODEL, base + i);
  onRateLimitLockout(ACCT, MODEL, 1000, base + cap); // tiny reset → window over
}

test('shouldSoftLimitModel is always off without the flag', () => {
  learnCap(20);
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 19; i++) recordUpstreamSend(ACCT, MODEL, base2 + i);
  const d = shouldSoftLimitModel(MODEL, base2 + 1000);
  assert.equal(d.limited, false, 'flag off → never limits');
});

test('soft limit fires at 85% of the learned cap and returns retryAfterMs', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  learnCap(20); // cap=20 → threshold ceil(20*0.85)=17
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 16; i++) recordUpstreamSend(ACCT, MODEL, base2 + i);
  let d = shouldSoftLimitModel(MODEL, base2 + 500);
  assert.equal(d.limited, false, '16/20 is under the 85% threshold');

  recordUpstreamSend(ACCT, MODEL, base2 + 600); // 17th
  d = shouldSoftLimitModel(MODEL, base2 + 700);
  assert.equal(d.limited, true, '17/20 hits the threshold');
  assert.ok(d.retryAfterMs > 0, 'retry hint points at the window end');
});

test('soft limit respects WINDSURFAPI_QUOTA_SOFT_PCT override', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  process.env.WINDSURFAPI_QUOTA_SOFT_PCT = '50';
  learnCap(20); // threshold ceil(20*0.5)=10
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 10; i++) recordUpstreamSend(ACCT, MODEL, base2 + i);
  const d = shouldSoftLimitModel(MODEL, base2 + 500);
  assert.equal(d.limited, true);
});

test('no learned cap → no soft limit (observe-only until first lockout)', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  for (let i = 0; i < 500; i++) recordUpstreamSend(ACCT, MODEL, T0 + i);
  const d = shouldSoftLimitModel(MODEL, T0 + 1000);
  assert.equal(d.limited, false);
});

test('an expired window never soft-limits', () => {
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  learnCap(20);
  const base2 = T0 + QUOTA_WINDOW_MS + 60_000;
  for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, MODEL, base2 + i);
  const d = shouldSoftLimitModel(MODEL, base2 + QUOTA_WINDOW_MS + 5000);
  assert.equal(d.limited, false, 'window expired → fresh budget');
});

// ─── gate integration (chat.js native route) ────────────────────

const tools = [
  { type: 'function', function: { name: 'exec', description: 'run', parameters: { type: 'object', properties: {} } } },
];

test('governor gate returns 429 before the native transport is called', async () => {
  const prevTools = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  process.env.WINDSURFAPI_QUOTA_GOVERNOR = '1';
  try {
    // Learn cap=20 for glm-5.2 and burn to the 85% threshold in a live window.
    const now = Date.now();
    for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, MODEL, now - QUOTA_WINDOW_MS - 60_000 + i);
    onRateLimitLockout(ACCT, MODEL, 1000, now - QUOTA_WINDOW_MS - 60_000 + 25);
    for (let i = 0; i < 17; i++) recordUpstreamSend(ACCT, MODEL, now - 1000 + i);

    let transportCalled = false;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => { transportCalled = true; return { text: 'x', stopReason: 2, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'x' }], tools },
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
  try {
    const now = Date.now();
    for (let i = 0; i < 20; i++) recordUpstreamSend(ACCT, MODEL, now - QUOTA_WINDOW_MS - 60_000 + i);
    onRateLimitLockout(ACCT, MODEL, 1000, now - QUOTA_WINDOW_MS - 60_000 + 25);
    for (let i = 0; i < 30; i++) recordUpstreamSend(ACCT, MODEL, now - 1000 + i);

    let transportCalled = false;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => { transportCalled = true; return { text: 'x', stopReason: 2, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'x' }], tools },
      ctx,
    );
    assert.equal(res.status, 200);
    assert.equal(transportCalled, true);
  } finally {
    if (prevTools !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prevTools;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});
