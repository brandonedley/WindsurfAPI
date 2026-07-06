// REF-1 / REF-2 (audit P1/P2) regression — when a background re-login swaps a
// pooled account's apiKey in place (reLoginAccount mutates account.apiKey), a
// finalize path holding the pre-relogin SNAPSHOT key must still:
//   REF-1: decrement the in-flight counter (release must find the account), and
//   REF-2: land the health/cooldown report (markQuotaExhausted etc.) on it.
// The fix resolves the account's CURRENT apiKey via its immutable id and
// releases by id, so a stale snapshot key no longer leaks the slot or silently
// no-ops the cooldown.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal,
  releaseAccountById, currentApiKeyForId,
} from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';

const createdIds = [];

function seed(label) {
  const key = `devin-session-token$ref-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

// Mimic acquire: capture a value snapshot (id + apiKey-at-acquire) and bump the
// pool object's in-flight counter, exactly like getApiKey does.
function acquireSnapshot(acct) {
  const live = getAccountInternal(acct.id);
  live._inflight = (live._inflight || 0) + 1;
  live._inflightAt = Date.now();
  return { id: acct.id, email: acct.email, apiKey: live.apiKey };
}

// Mimic reLoginAccount's in-place re-key WITHOUT touching the snapshot.
function relogin(acct, newKey) {
  const live = getAccountInternal(acct.id);
  live.apiKey = newKey;
  return newKey;
}

afterEach(() => { while (createdIds.length) removeAccount(createdIds.pop()); });

describe('REF-1: finalize releases the in-flight slot after an in-place re-key', () => {
  it('decrements _inflight to 0 even though the snapshot key is stale', () => {
    const acct = seed('relogin-release');
    const snap = acquireSnapshot(acct);
    assert.equal(getAccountInternal(acct.id)._inflight, 1, 'slot acquired');

    // Background re-login mints a fresh token and re-keys the pool object.
    relogin(acct, `${snap.apiKey}$FRESH`);
    assert.notEqual(getAccountInternal(acct.id).apiKey, snap.apiKey, 'account re-keyed');

    // Finalize with the STALE snapshot — must still find + release the slot.
    finalizeConnectAccount(snap, { model: 'test-model', startTime: Date.now(), err: null });
    assert.equal(getAccountInternal(acct.id)._inflight, 0, 'in-flight slot released (no leak)');
  });

  it('releaseAccountById is the primitive that survives the re-key', () => {
    const acct = seed('release-by-id');
    const snap = acquireSnapshot(acct);
    relogin(acct, `${snap.apiKey}$ROTATED`);
    releaseAccountById(snap.id);
    assert.equal(getAccountInternal(acct.id)._inflight, 0, 'released by immutable id');
  });
});

describe('REF-2: finalize lands the cooldown on the re-keyed account', () => {
  it('markQuotaExhausted via finalize writes quotaResetAt despite the stale key', () => {
    const acct = seed('relogin-quota');
    const snap = acquireSnapshot(acct);
    relogin(acct, `${snap.apiKey}$FRESH2`);

    const err = Object.assign(new Error('out of credit'), { code: 'QUOTA_EXHAUSTED' });
    finalizeConnectAccount(snap, { model: 'test-model', startTime: Date.now(), err });

    const live = getAccountInternal(acct.id);
    assert.ok(live.quotaResetAt && live.quotaResetAt > Date.now(), 'quota cooldown recorded on the live account');
    assert.equal(live._inflight, 0, 'slot still released on the error path');
  });

  it('currentApiKeyForId resolves the live key and falls back for unknown ids', () => {
    const acct = seed('resolve');
    relogin(acct, `${getAccountInternal(acct.id).apiKey}$NOW`);
    assert.equal(currentApiKeyForId(acct.id, 'stale'), getAccountInternal(acct.id).apiKey);
    assert.equal(currentApiKeyForId('no-such-id', 'fallback-key'), 'fallback-key');
  });
});
