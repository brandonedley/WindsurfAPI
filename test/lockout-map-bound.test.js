// LOCK-2 (audit P1, unauth-reachable) regression — the per-IP dashboard
// brute-force lockout Map is reached BEFORE the API-key gate, so an attacker
// presenting distinct source IPs (spoofed XFF pre-fix, IPv6 /64 rotation, a
// botnet) could grow it without bound and OOM the single process. The Map now
// has a hard entry cap with oldest-non-banned eviction: a distinct-IP flood
// stays bounded and can never wipe a live ban.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  failedAuthAttempt, checkLockout, getLockoutState,
  _resetLockoutForTests, __setLockoutMaxForTests, __lockoutSizeForTests,
} from '../src/auth.js';

let prevMax;
beforeEach(() => { _resetLockoutForTests(); prevMax = __setLockoutMaxForTests(100); });
afterEach(() => { __setLockoutMaxForTests(prevMax); _resetLockoutForTests(); });

describe('LOCK-2: _lockoutAttempts Map is hard-bounded', () => {
  it('does not grow past the cap under a distinct-IP flood', () => {
    const CAP = 100;
    __setLockoutMaxForTests(CAP);
    // 10x the cap in unique IPs, one failure each (never reaching a ban).
    for (let i = 0; i < CAP * 10; i++) {
      failedAuthAttempt(`10.0.${(i >> 8) & 255}.${i & 255}`);
    }
    assert.ok(
      __lockoutSizeForTests() <= CAP,
      `map size ${__lockoutSizeForTests()} must stay <= cap ${CAP}`,
    );
  });

  it('completes a large flood quickly (bounded per-insert cost, DoS proof)', () => {
    __setLockoutMaxForTests(1000);
    const t0 = Date.now();
    for (let i = 0; i < 200_000; i++) {
      failedAuthAttempt(`198.18.${(i >> 8) & 255}.${i & 255}`);
    }
    const elapsed = Date.now() - t0;
    assert.ok(__lockoutSizeForTests() <= 1000, 'stayed bounded');
    assert.ok(elapsed < 5000, `200k distinct-IP inserts took ${elapsed}ms, expected < 5s`);
  });

  it('evicts the OLDEST entry when full (FIFO among non-banned)', () => {
    __setLockoutMaxForTests(3);
    failedAuthAttempt('a'); // oldest
    failedAuthAttempt('b');
    failedAuthAttempt('c');
    assert.equal(__lockoutSizeForTests(), 3);
    failedAuthAttempt('d'); // triggers eviction of 'a'
    assert.equal(__lockoutSizeForTests(), 3, 'still at cap');
    assert.equal(getLockoutState('a').count, 0, 'oldest "a" was evicted (fresh state)');
    assert.equal(getLockoutState('d').count, 1, 'new "d" was inserted');
  });

  it('NEVER evicts an entry under an active ban to make room', () => {
    const CAP = 5;
    __setLockoutMaxForTests(CAP);
    // Ban 'victim' by hitting the 5-strike threshold.
    for (let i = 0; i < 5; i++) failedAuthAttempt('victim');
    assert.ok(checkLockout('victim').blocked, 'victim is banned');
    // Fill the rest and then flood well past capacity with new IPs.
    for (let i = 0; i < CAP * 20; i++) failedAuthAttempt(`flood-${i}`);
    assert.ok(__lockoutSizeForTests() <= CAP, 'stayed bounded');
    assert.ok(checkLockout('victim').blocked, 'victim ban survived the flood — never evicted');
  });
});
