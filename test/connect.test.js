import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  gunzip, tryGunzip, unwrapRequest,
  wrapEnvelope, StreamingFrameParser, MAX_FRAME_SIZE,
} from '../src/connect.js';

// ─── CONN-1: decompression output must be bounded ─────────────────────────
//
// A hijacked / compromised upstream (or MITM'd US-proxy) can send a Connect-RPC
// frame whose gzip payload is small on the wire (passes the ≤16MB frame-length
// guard) but inflates to gigabytes. Without maxOutputLength, gunzipSync
// accumulates up to kMaxLength (~2GB) and on a memory-constrained host the
// OOM-killer can reap the single-process proxy before the error is caught.
// The fix caps every decompression path at MAX_FRAME_SIZE. These tests prove the
// cap trips on a high-ratio bomb using a tiny, sub-second input (a ~17MB run of
// zeros compresses to a few KB) rather than actually allocating anything huge.

describe('CONN-1: gzip decompression is bounded by MAX_FRAME_SIZE', () => {
  // Build a gzip payload that decompresses to just over the cap.
  function makeBomb() {
    const raw = Buffer.alloc(MAX_FRAME_SIZE + 1024); // all zeros → compresses tiny
    const compressed = gzipSync(raw);
    assert.ok(compressed.length < MAX_FRAME_SIZE, 'bomb is small on the wire (passes length guard)');
    return compressed;
  }

  it('StreamingFrameParser.drain rejects a high-ratio gzip frame instead of allocating GBs', () => {
    const bomb = makeBomb();
    // flags 0x01 (gzip), wire length = compressed size (well under 16MB).
    const frame = Buffer.alloc(5 + bomb.length);
    frame[0] = 0x01;
    frame.writeUInt32BE(bomb.length, 1);
    bomb.copy(frame, 5);

    const parser = new StreamingFrameParser();
    parser.push(frame);
    assert.throws(() => parser.drain(), /decompression failed/i);
  });

  it('drain completes in well under a second (bounded, not a real 2GB alloc)', () => {
    const bomb = makeBomb();
    const frame = Buffer.alloc(5 + bomb.length);
    frame[0] = 0x01;
    frame.writeUInt32BE(bomb.length, 1);
    bomb.copy(frame, 5);

    const parser = new StreamingFrameParser();
    parser.push(frame);
    const t0 = Date.now();
    assert.throws(() => parser.drain());
    assert.ok(Date.now() - t0 < 1000, 'the cap trips quickly, no gigabyte accumulation');
  });

  it('gunzip() (shared helper) throws on a bomb rather than inflating unbounded', () => {
    assert.throws(() => gunzip(makeBomb()), /Buffer/i);
  });

  it('tryGunzip() returns null on a bomb (never inflates unbounded)', () => {
    assert.equal(tryGunzip(makeBomb()), null);
  });

  it('unwrapRequest caps an envelope-wrapped gzip bomb', () => {
    const bomb = makeBomb();
    const frame = Buffer.alloc(5 + bomb.length);
    frame[0] = 0x01;
    frame.writeUInt32BE(bomb.length, 1);
    bomb.copy(frame, 5);
    assert.throws(() => unwrapRequest(frame), /Buffer/i);
  });

  it('unwrapRequest caps an HTTP-level content-encoding: gzip bomb', () => {
    assert.throws(
      () => unwrapRequest(makeBomb(), { 'content-encoding': 'gzip' }),
      /Buffer/i,
    );
  });

  // Regression guard: a legitimately-sized gzip frame still round-trips.
  it('a normal gzip frame under the cap still decodes correctly', () => {
    const body = Buffer.from('the answer is 42');
    const frame = wrapEnvelope(body, { compress: true });
    const parser = new StreamingFrameParser();
    parser.push(frame);
    const frames = parser.drain();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString('utf8'), 'the answer is 42');
  });

  it('the frame-length guard still rejects an absurd advertised length', () => {
    // A frame header claiming > 16MB payload must be rejected before any read.
    const frame = Buffer.alloc(5);
    frame[0] = 0x00;
    frame.writeUInt32BE(MAX_FRAME_SIZE + 1, 1);
    const parser = new StreamingFrameParser();
    parser.push(frame);
    assert.throws(() => parser.drain(), /frame size/i);
  });
});
