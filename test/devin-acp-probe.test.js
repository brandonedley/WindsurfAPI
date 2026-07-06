import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeDevinCliAvailable, __resetDevinAcpProbeCache } from '../src/devin-acp.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

// AP1: zero-billable proactive availability probe.
//
// The probe answers "is the Devin CLI runnable on this box?" by spawning
// `devin --version` ONLY — it never runs initialize/authenticate/session.new/
// session/prompt, so it cannot consume account quota or upstream tokens. These
// tests prove: availability detection (runnable / ENOENT / non-zero exit),
// caching + path-keyed invalidation, the DEVIN_ACP_PROBE=0 opt-out, that the
// probe NEVER speaks ACP (zero-billable), and that the handler fails fast with
// 503 backend_unavailable WITHOUT checking out an account. All against fakes /
// node itself — no real Devin CLI, no account, no network.

const ENV_KEYS = [
  'DEVIN_CLI_PATH',
  'DEVIN_ACP_PROBE',
  'DEVIN_ACP_PROBE_ARGS_JSON',
  'DEVIN_ACP_PROBE_TTL_MS',
  'DEVIN_ACP_PROBE_TIMEOUT_MS',
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_ENABLED',
  'DEVIN_CLI_MODE',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

beforeEach(() => {
  __resetDevinAcpProbeCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  __resetDevinAcpProbeCache();
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-probe-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-probe.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

describe('probeDevinCliAvailable — zero-billable availability detection', () => {
  it('reports available when the binary runs and exits 0 (node --version)', async () => {
    process.env.DEVIN_CLI_PATH = process.execPath; // node, `node --version` → exit 0
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, true);
    assert.equal(r.reason, 'ok');
    assert.equal(r.exitCode, 0);
    assert.equal(r.cached, false);
  });

  it('reports unavailable with reason "not_found" when the binary is missing (ENOENT)', async () => {
    process.env.DEVIN_CLI_PATH = join(tmpdir(), 'no-such-devin-binary-probe-xyz');
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'not_found');
  });

  it('stays available on a non-zero exit (binary present, just does not grok --version)', async () => {
    // A fake that exits non-zero regardless of args: presence is proven by the
    // fact it ran to exit at all, so we must NOT false-negative a working CLI.
    const script = mkScript(`process.exit(3);`);
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_ACP_PROBE_ARGS_JSON = JSON.stringify([script]);
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, true);
    assert.equal(r.reason, 'present_nonzero_exit');
    assert.equal(r.exitCode, 3);
  });

  it('honours DEVIN_ACP_PROBE=0 — skips the probe and assumes available (no spawn)', async () => {
    // Point at a missing binary: if the probe actually ran it would report
    // not_found. skipped:true proves it short-circuited without spawning.
    process.env.DEVIN_CLI_PATH = join(tmpdir(), 'no-such-devin-binary-skip');
    process.env.DEVIN_ACP_PROBE = '0';
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, true);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'probe_disabled');
  });

  it('caches the verdict within TTL and re-probes when the binary path changes', async () => {
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_ACP_PROBE_TTL_MS = '60000';
    const first = await probeDevinCliAvailable();
    assert.equal(first.cached, false);
    const second = await probeDevinCliAvailable();
    assert.equal(second.cached, true);
    assert.equal(second.available, true);

    // Switching to a different (missing) path must invalidate the cache —
    // a stale "available" verdict for the old binary must not leak.
    process.env.DEVIN_CLI_PATH = join(tmpdir(), 'different-missing-binary');
    const third = await probeDevinCliAvailable();
    assert.equal(third.cached, false);
    assert.equal(third.available, false);
    assert.equal(third.reason, 'not_found');
  });

  it('force:true bypasses a fresh cache entry', async () => {
    process.env.DEVIN_CLI_PATH = process.execPath;
    await probeDevinCliAvailable();
    const forced = await probeDevinCliAvailable({ force: true });
    assert.equal(forced.cached, false);
  });

  it('reports unavailable (probe_timeout) for a binary that hangs past the timeout', async () => {
    // A fake that never exits. The probe must give up and treat it unavailable
    // rather than block routing forever.
    const script = mkScript(`setInterval(() => {}, 1000);`);
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_ACP_PROBE_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_ACP_PROBE_TIMEOUT_MS = '300';
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'probe_timeout');
  });

  it('is zero-billable: the probe never speaks ACP (no initialize/authenticate/session/prompt)', async () => {
    // The fake records every JSON-RPC method it receives on stdin to a marker
    // file. The probe spawns with stdio ['ignore','ignore','ignore'] and writes
    // NOTHING, so the recorded method list must be empty — proving the probe
    // opens no session and sends no prompt (cannot consume quota/tokens).
    const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-probe-bill-'));
    tmpDirs.push(dir);
    const marker = join(dir, 'methods.json');
    const script = join(dir, 'fake-probe-record.mjs');
    writeFileSync(script, `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const methods = [];
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(methods));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try { const m = JSON.parse(line); if (m.method) methods.push(m.method); } catch {}
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(methods));
});
// Exit promptly so the probe sees a clean close; no stdin should ever arrive.
setTimeout(() => process.exit(0), 50);
`, 'utf8');
    process.env.DEVIN_CLI_PATH = process.execPath;
    process.env.DEVIN_ACP_PROBE_ARGS_JSON = JSON.stringify([script]);
    process.env.DEVIN_ACP_PROBE_TIMEOUT_MS = '2000';
    const r = await probeDevinCliAvailable();
    assert.equal(r.available, true);
    assert.ok(existsSync(marker), 'fake probe target should have run');
    const recorded = JSON.parse(readFileSync(marker, 'utf8'));
    assert.deepEqual(recorded, [], 'probe must not send any JSON-RPC method (no session/prompt)');
  });
});

describe('handler — proactive probe gates ACP routing before checkout', () => {
  it('returns 503 backend_unavailable WITHOUT checking out an account when the probe fails', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';

    let checkoutCalls = 0;
    let runnerCalls = 0;
    let reportedFailure = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      specialAgent: {
        probeDevinCliAvailable: async () => ({ available: false, reason: 'not_found' }),
        checkoutAccount: () => { checkoutCalls++; return { id: 'a', apiKey: 'k' }; },
        runDevinAcp: async () => { runnerCalls++; return { text: 'x' }; },
        reportError: () => { reportedFailure++; },
      },
    });

    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'backend_unavailable');
    assert.equal(result.body.error.probe_reason, 'not_found');
    assert.equal(checkoutCalls, 0, 'must not reserve an account when the CLI is unavailable');
    assert.equal(runnerCalls, 0, 'must not spawn the runner when the CLI is unavailable');
    assert.equal(reportedFailure, 0, 'pool health must be untouched — this is an env fault, not an account fault');
  });

  it('proceeds to checkout + runner when the probe reports available', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';

    let checkoutCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      specialAgent: {
        probeDevinCliAvailable: async () => ({ available: true, reason: 'ok' }),
        checkoutAccount: () => { checkoutCalls++; return { id: 'a', apiKey: 'k', apiServerUrl: '' }; },
        runDevinAcp: async () => ({ text: 'ACP_OK' }),
        releaseAccount: () => {},
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'ACP_OK');
    assert.equal(checkoutCalls, 1);
  });

  it('does NOT probe in print mode (print keeps its own post-spawn ENOENT handling)', async () => {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'print';
    process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '0';

    let probeCalls = 0;
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      specialAgent: {
        probeDevinCliAvailable: async () => { probeCalls++; return { available: false }; },
        runDevinPrint: async () => ({ text: 'PRINT_OK' }),
      },
    });

    assert.equal(probeCalls, 0, 'print mode must not invoke the ACP probe');
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'PRINT_OK');
  });
});

describe('reportRunFailure — 503 backend_unavailable does not burn pool health (gap-c)', () => {
  // reportRunFailure is private; exercise it through the handler by injecting a
  // runner that throws the relevant error and spying on the pool-feedback deps.
  async function runWithFailure(err, extraDeps = {}) {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_ACP_PROBE = '0'; // skip the gate so the runner actually runs
    const calls = { generic: 0, rateLimited: 0, internal: 0, ban: 0 };
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      specialAgent: {
        checkoutAccount: () => ({ id: 'a', apiKey: 'k', apiServerUrl: '' }),
        releaseAccount: () => {},
        refundReservation: () => {},
        reportError: () => { calls.generic++; },
        markRateLimited: () => { calls.rateLimited++; },
        reportInternalError: () => { calls.internal++; },
        reportBanSignal: () => { calls.ban++; },
        runDevinAcp: async () => { throw err; },
        ...extraDeps,
      },
    });
    return { result, calls };
  }

  it('a 503 backend_unavailable from the runner is NOT counted against the account', async () => {
    const err = Object.assign(new Error('Devin CLI not found: devin'), {
      status: 503, type: 'backend_unavailable',
    });
    const { result, calls } = await runWithFailure(err);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.type, 'backend_unavailable');
    assert.equal(calls.generic, 0, 'env fault must not feed the generic-error streak');
    assert.equal(calls.rateLimited, 0);
    assert.equal(calls.internal, 0);
    assert.equal(calls.ban, 0);
  });

  it('a 499 request_aborted is NOT counted against the account', async () => {
    const err = Object.assign(new Error('Request aborted'), {
      status: 499, type: 'request_aborted',
    });
    const { calls } = await runWithFailure(err);
    assert.equal(calls.generic, 0, 'client abort must not feed the error streak');
  });

  it('a genuine 502 backend_error STILL feeds the generic-error streak (sanity)', async () => {
    const err = Object.assign(new Error('something broke'), {
      status: 502, type: 'backend_error',
    });
    const { calls } = await runWithFailure(err);
    assert.equal(calls.generic, 1, 'a real backend fault must still report to the pool');
  });
});
