import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  removeAccount,
  reportError,
  __serializeAccounts,
  __deserializeAccount,
  __maybeRecoverErrorAccount,
} from '../src/auth.js';

// AP-RISK-1 follow-up: error-recovery timestamps must survive a restart.
// Before this fix _serializeAccounts omitted erroredAt and loadAccounts never
// restored it, so a persisted 'error' account came back with erroredAt=0 →
// maybeRecoverErrorAccount computed since=0 and bailed forever, shrinking the
// pool monotonically across restarts. These tests drive the pure serialize/
// deserialize seams (no disk, no dedup) plus the recovery gate directly.

const createdIds = [];
function addTestAccount(label = 'err-persist') {
  const account = addAccountByKey(`erp-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(account.id);
  return account;
}

afterEach(() => {
  delete process.env.WINDSURFAPI_ERROR_RECOVERY_MS;
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('auth — error-recovery timestamp persistence', () => {
  it('serialize→load round-trip preserves erroredAt', () => {
    const acct = addTestAccount('roundtrip');
    reportError(acct.apiKey);
    reportError(acct.apiKey);
    reportError(acct.apiKey);
    assert.equal(acct.status, 'error', 'three errors disable');
    assert.ok(acct.erroredAt > 0, 'erroredAt stamped on flip');

    const serialized = __serializeAccounts().find(a => a.apiKey === acct.apiKey);
    assert.ok(serialized, 'account is serialized');
    assert.equal(serialized.erroredAt, acct.erroredAt, 'erroredAt is written to the persisted record');

    const restored = __deserializeAccount(serialized);
    assert.equal(restored.status, 'error', 'status survives');
    assert.equal(restored.erroredAt, acct.erroredAt, 'erroredAt survives the round-trip exactly');
  });

  it('_errorAt (transient streak field) is NOT persisted', () => {
    const acct = addTestAccount('no-transient');
    reportError(acct.apiKey); // sets acct._errorAt but not status
    assert.ok(acct._errorAt > 0, 'reportError stamps the transient _errorAt');
    const serialized = __serializeAccounts().find(a => a.apiKey === acct.apiKey);
    assert.equal('_errorAt' in serialized, false, '_errorAt must not survive restart');
  });

  it('a status==="error" account with no persisted erroredAt gets one at load time', () => {
    const now = 1_700_000_000_000;
    // Older accounts.json record: flipped to error before erroredAt was persisted.
    const legacy = { apiKey: 'legacy-err', email: 'x@y.com', status: 'error' };
    const restored = __deserializeAccount(legacy, now);
    assert.equal(restored.erroredAt, now, 'defaults erroredAt to load time so it re-probes after cooldown');
  });

  it('a non-error account with no erroredAt stays 0 (default does not over-apply)', () => {
    const now = 1_700_000_000_000;
    const active = { apiKey: 'active-1', email: 'x@y.com', status: 'active' };
    const restored = __deserializeAccount(active, now);
    assert.equal(restored.erroredAt, 0, 'active accounts do not get a synthetic erroredAt');
  });

  it('maybeRecoverErrorAccount no longer bails with since=0 after restart', () => {
    process.env.WINDSURFAPI_ERROR_RECOVERY_MS = '1000';
    const now = 2_000_000_000_000;
    // Simulate a restart: legacy 'error' record with no erroredAt, restored earlier.
    const loadedAt = now - 5000; // loaded well before "now"
    const restored = __deserializeAccount({ apiKey: 'restart-err', email: 'x@y.com', status: 'error' }, loadedAt);
    assert.ok(restored.erroredAt > 0, 'load defaulted erroredAt so recovery has a real since');

    // With the old bug, erroredAt would be 0 → since=0 → recovery bails forever.
    __maybeRecoverErrorAccount(restored, now);
    assert.equal(restored.status, 'active', 'account half-open recovers after the cooldown post-restart');
    assert.equal(restored.errorCount, 0, 'error count cleared on recovery');
  });

  it('a persisted erroredAt still inside the TTL is not prematurely recovered', () => {
    process.env.WINDSURFAPI_ERROR_RECOVERY_MS = String(60 * 60 * 1000);
    const now = 2_000_000_000_000;
    const restored = __deserializeAccount(
      { apiKey: 'fresh-err', email: 'x@y.com', status: 'error', erroredAt: now - 1000 },
      now,
    );
    __maybeRecoverErrorAccount(restored, now);
    assert.equal(restored.status, 'error', 'still cooling down inside the TTL');
  });
});
