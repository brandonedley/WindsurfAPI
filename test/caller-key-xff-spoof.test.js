// v2.0.55 audit H2 regression — X-Forwarded-For must NOT be trusted by
// default. An attacker with the shared API key cannot land in another
// caller's bucket by setting XFF + UA. The only way to enable XFF trust
// is `TRUST_PROXY_X_FORWARDED_FOR=1`, which operators behind a trusted
// reverse proxy may set.
//
// We exercise the env via dynamic import on a cleared module cache so
// the `TRUST_PROXY_XFF` constant captured at module-load picks up the
// test-set value.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function mkReq(xff, ip, ua = 'claude-cli/1.0') {
  return {
    headers: {
      'x-forwarded-for': xff,
      'user-agent': ua,
    },
    socket: { remoteAddress: ip },
  };
}

async function loadCallerKeyFresh(envValue) {
  // Module cache busting via query param. Each fresh import re-reads
  // process.env.TRUST_PROXY_X_FORWARDED_FOR at module-eval time.
  if (envValue === undefined) delete process.env.TRUST_PROXY_X_FORWARDED_FOR;
  else process.env.TRUST_PROXY_X_FORWARDED_FOR = envValue;
  const stamp = Date.now() + Math.random();
  return await import(`../src/caller-key.js?fresh=${stamp}`);
}

describe('callerKeyFromRequest — XFF spoofing guard (audit H2)', () => {
  it('default mode: spoofed XFF cannot collide with victim using attacker socket IP', async () => {
    const m = await loadCallerKeyFresh(undefined);
    const apiKey = 'sk-shared';
    // Victim hits the proxy directly from 203.0.113.1 — no XFF.
    const victim = m.callerKeyFromRequest(
      mkReq(undefined, '203.0.113.1'),
      apiKey,
      {},
    );
    // Attacker connects from 198.51.100.200 but spoofs XFF=203.0.113.1.
    // Without XFF trust the fingerprint should fall back to
    // socket.remoteAddress and stay distinct.
    const attacker = m.callerKeyFromRequest(
      mkReq('203.0.113.1', '198.51.100.200'),
      apiKey,
      {},
    );
    assert.notEqual(victim, attacker, 'attacker must not collide with victim by XFF spoof');
  });

  it('default mode: same socket IP+UA → same caller bucket (legitimate cross-turn reuse)', async () => {
    const m = await loadCallerKeyFresh(undefined);
    const a = m.callerKeyFromRequest(mkReq(undefined, '203.0.113.5'), 'sk', {});
    const b = m.callerKeyFromRequest(mkReq(undefined, '203.0.113.5'), 'sk', {});
    assert.equal(a, b, 'two calls from same IP+UA must share callerKey');
  });

  it('TRUST_PROXY_X_FORWARDED_FOR=1: XFF first hop is honoured (legacy reverse-proxy mode)', async () => {
    const m = await loadCallerKeyFresh('1');
    // When operator opts in, XFF first hop wins over socket.remoteAddress.
    const fromXff = m.callerKeyFromRequest(mkReq('203.0.113.1', '198.51.100.200'), 'sk', {});
    const fromSocket = m.callerKeyFromRequest(mkReq(undefined, '203.0.113.1'), 'sk', {});
    assert.equal(fromXff, fromSocket, 'XFF first hop must match direct socket IP under trust mode');
  });

  it('apiKey-less fallback path also respects the env gate', async () => {
    const m = await loadCallerKeyFresh(undefined);
    const victim = m.callerKeyFromRequest(mkReq(undefined, '203.0.113.7'), '', {});
    const attacker = m.callerKeyFromRequest(mkReq('203.0.113.7', '198.51.100.200'), '', {});
    assert.notEqual(victim, attacker, 'fallback path must not trust spoofed XFF either');
  });
});

describe('callerKeyFromRequest — XFF read from the RIGHT by trusted hops (audit P1 XFF-1)', () => {
  it('trust mode: leftmost (client-controlled) XFF value is IGNORED', async () => {
    const m = await loadCallerKeyFresh('1');
    // One trusted proxy (default hops=1). The proxy appended the real client
    // (203.0.113.9) on the right; the attacker prepended a spoof on the left.
    const spoofed = m.callerKeyFromRequest(mkReq('1.2.3.4, 203.0.113.9', '10.0.0.1'), 'sk', {});
    // Same real client, no spoof prefix.
    const honest = m.callerKeyFromRequest(mkReq('203.0.113.9', '10.0.0.1'), 'sk', {});
    assert.equal(spoofed, honest, 'left-prepended spoof must not change the bucket');
  });

  it('trust mode: attacker rotating the leftmost value cannot land in distinct buckets', async () => {
    const m = await loadCallerKeyFresh('1');
    const a = m.callerKeyFromRequest(mkReq('9.9.9.1, 203.0.113.9', '10.0.0.1'), 'sk', {});
    const b = m.callerKeyFromRequest(mkReq('9.9.9.2, 203.0.113.9', '10.0.0.1'), 'sk', {});
    assert.equal(a, b, 'rotating the spoofed prefix must not evade a per-IP bucket');
  });

  it('trust mode: honours TRUST_PROXY_HOPS=2 (two proxies append on the right)', async () => {
    process.env.TRUST_PROXY_HOPS = '2';
    try {
      const m = await loadCallerKeyFresh('1');
      // client, then proxy1, then proxy2 appended → real client is 3rd-from-left
      // = 2nd-from-right's predecessor. With hops=2 we take parts[len-2].
      const withSpoof = m.callerKeyFromRequest(mkReq('evil, 203.0.113.20, 172.16.0.1', '10.0.0.1'), 'sk', {});
      const honest = m.callerKeyFromRequest(mkReq('203.0.113.20, 172.16.0.1', '10.0.0.1'), 'sk', {});
      assert.equal(withSpoof, honest, 'hops=2 must pick the entry before the 2 trusted proxies');
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
  });

  it('trust mode: header shorter than hop count falls back to socket peer', async () => {
    process.env.TRUST_PROXY_HOPS = '3';
    try {
      const m = await loadCallerKeyFresh('1');
      const fromShortXff = m.callerKeyFromRequest(mkReq('203.0.113.30', '198.51.100.9'), 'sk', {});
      const fromSocket = m.callerKeyFromRequest(mkReq(undefined, '198.51.100.9'), 'sk', {});
      assert.equal(fromShortXff, fromSocket, 'untrustworthy short XFF must fall back to socket.remoteAddress');
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
  });
});
