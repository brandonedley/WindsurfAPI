import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageBody } from '../src/handlers/chat.js';

// O11: usage.completion_tokens_details.reasoning_tokens was hardcoded 0 even when
// the model produced visible thinking content. It is now estimated with the same
// chars/4 heuristic used for completion tokens, and clamped to completion_tokens
// (OpenAI's invariant: reasoning_tokens ⊆ completion_tokens).

const SERVER_USAGE = { inputTokens: 100, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('O11: reasoning_tokens estimation (server-usage branch)', () => {
  it('is 0 when there is no thinking text', () => {
    const usage = buildUsageBody(SERVER_USAGE, [], 'answer', '', null);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 0);
  });

  it('estimates chars/4 of the thinking text when present', () => {
    const thinking = 'x'.repeat(400); // 400 chars → 100 tokens
    const usage = buildUsageBody(SERVER_USAGE, [], 'answer', thinking, null);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 100);
  });

  it('clamps reasoning_tokens to completion_tokens (subset invariant)', () => {
    // Thinking text alone estimates to 1000 tokens, but the upstream
    // completion_tokens is only 500 — reasoning is a subset, so it caps at 500.
    const thinking = 'x'.repeat(4000); // 4000 chars → 1000 tokens
    const usage = buildUsageBody(SERVER_USAGE, [], 'answer', thinking, null);
    assert.equal(usage.completion_tokens, 500);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 500,
      'reasoning_tokens never exceeds completion_tokens');
  });
});

describe('O11: reasoning_tokens estimation (chars/4 fallback branch)', () => {
  it('is 0 with no thinking text and no server usage', () => {
    const usage = buildUsageBody(null, [{ role: 'user', content: 'hi' }], 'answer', '', null);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 0);
  });

  it('estimates thinking tokens as a subset of the folded completion count', () => {
    // No server usage → completion = (completionText + thinkingText) chars / 4.
    // completionText 'answer' = 6 chars, thinking 200 chars → completion = ceil(206/4) = 52,
    // reasoning = ceil(200/4) = 50, which is ≤ 52.
    const usage = buildUsageBody(null, [{ role: 'user', content: 'hi' }], 'answer', 'y'.repeat(200), null);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 50);
    assert.ok(usage.completion_tokens_details.reasoning_tokens <= usage.completion_tokens,
      'reasoning ⊆ completion in the fallback branch too');
  });
});
