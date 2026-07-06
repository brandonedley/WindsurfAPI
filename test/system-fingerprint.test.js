import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { systemFingerprint } from '../src/system-fingerprint.js';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';

// O9 (ROADMAP-GATE §1 序 14): OpenAI responses carry a top-level
// system_fingerprint. We're a translation proxy with no real backend entropy,
// so we emit a *stable synthetic* value derived only from the echoed model —
// same model → same fp (client run-to-run consistency), different model →
// different fp. Never random, never time-based.

const FP_RE = /^fp_[0-9a-f]{10}$/;

describe('systemFingerprint helper', () => {
  it('shape: fp_ + 10 lowercase hex, total length 13', () => {
    const fp = systemFingerprint('claude-sonnet-4.6');
    assert.match(fp, FP_RE);
    assert.equal(fp.length, 13);
  });

  it('deterministic: same model → same fp', () => {
    assert.equal(systemFingerprint('claude-sonnet-4.6'), systemFingerprint('claude-sonnet-4.6'));
  });

  it('discriminates: different models → different fp', () => {
    assert.notEqual(systemFingerprint('m-a'), systemFingerprint('m-b'));
  });

  it('never throws on undefined/empty model (unknown branch)', () => {
    assert.match(systemFingerprint(undefined), FP_RE);
    assert.match(systemFingerprint(''), FP_RE);
    assert.equal(systemFingerprint(undefined), systemFingerprint(''));
  });
});

// A scripted fake streamChat for the devin-connect-openai adapter.
function fakeStream(events) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

const SAMPLE = [
  { type: 'content', text: 'hi' },
  { type: 'finish', reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
];

describe('O9 devin-connect-openai fingerprint injection', () => {
  afterEach(() => __setStreamChatForTest(null));

  it('non-stream body carries system_fingerprint (fp_ prefix)', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { body } = await toChatCompletion({ model: 'claude-sonnet-4-6', messages: [] });
    assert.match(body.system_fingerprint, FP_RE);
    assert.equal(body.system_fingerprint, systemFingerprint('claude-sonnet-4-6'));
  });

  it('every stream chunk carries the same system_fingerprint', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const frames = [];
    await streamChatCompletion({ model: 'claude-sonnet-4-6', messages: [] }, (d) => frames.push(d), { displayModel: 'claude-sonnet-4-6' });
    const chunks = frames.filter(f => f.object === 'chat.completion.chunk');
    assert.ok(chunks.length >= 1);
    for (const c of chunks) assert.match(c.system_fingerprint, FP_RE);
    const uniq = new Set(chunks.map(c => c.system_fingerprint));
    assert.equal(uniq.size, 1);
  });

  it('non-stream fp === stream fp for the same displayModel (cross-shape)', async () => {
    __setStreamChatForTest(fakeStream(SAMPLE));
    const { body } = await toChatCompletion({ model: 'x', messages: [] }, { displayModel: 'claude-sonnet-4-6' });
    __setStreamChatForTest(fakeStream(SAMPLE));
    const frames = [];
    await streamChatCompletion({ model: 'x', messages: [] }, (d) => frames.push(d), { displayModel: 'claude-sonnet-4-6' });
    const chunkFp = frames.find(f => f.object === 'chat.completion.chunk').system_fingerprint;
    assert.equal(body.system_fingerprint, chunkFp);
  });
});
