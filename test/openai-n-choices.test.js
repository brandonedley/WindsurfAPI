import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';

// O2 (ROADMAP-GATE §1 序 7): n>1 must be rejected explicitly with a 400
// invalid_request_error rather than silently returning a single choice. The
// Cascade/Devin upstream only ever returns one completion, so a client reading
// choices[1..n-1] would otherwise pick up undefined.

const baseReq = (extra) => ({
  model: 'claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

// A request that passes O2 must NOT come back as a 400 whose error.param is 'n'.
const rejectedByO2 = (result) =>
  result?.status === 400 && result?.body?.error?.param === 'n';

describe('O2 n>1 rejection', () => {
  it('rejects n:2 with 400 invalid_request_error param=n', async () => {
    const result = await handleChatCompletions(baseReq({ n: 2 }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.param, 'n');
    assert.match(result.body.error.message, /n=1/);
    // Non-stream JSON path (no result.stream flag) even without stream:true.
    assert.ok(!result.stream);
  });

  it('rejects n:5 (any value >1)', async () => {
    const result = await handleChatCompletions(baseReq({ n: 5 }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.param, 'n');
  });

  it('rejects n:0 (boundary: any value != 1)', async () => {
    const result = await handleChatCompletions(baseReq({ n: 0 }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.param, 'n');
  });

  it('rejects stream:true + n:2 with a JSON 400 (not SSE)', async () => {
    const result = await handleChatCompletions(baseReq({ stream: true, n: 2 }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.param, 'n');
    // O2 fires before the stream branch, so no SSE handler is produced.
    assert.ok(!result.stream);
  });

  it('lets n:1 pass O2 (not rejected as param=n)', async () => {
    const result = await handleChatCompletions(baseReq({ n: 1 }));
    assert.ok(!rejectedByO2(result));
  });

  it('lets omitted n pass O2 (default behaviour)', async () => {
    const result = await handleChatCompletions(baseReq({}));
    assert.ok(!rejectedByO2(result));
  });
});
