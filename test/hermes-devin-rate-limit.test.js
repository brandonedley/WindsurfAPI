import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOpenAIRateLimitError, parseUpstreamRetryAfterMs } from '../src/hermes-devin/rate-limit.js';

describe('Hermes Devin rate-limit compatibility', () => {
  it('parses English reset durations', () => {
    const ms = parseUpstreamRetryAfterMs('Reached message rate limit for this model. Please try again later. Resets in: 2h59m43s');
    assert.equal(ms, ((2 * 3600) + (59 * 60) + 43) * 1000);
  });

  it('parses Chinese retry-after seconds', () => {
    const ms = parseUpstreamRetryAfterMs('所有可用账号暂时不可用，请 10745 秒后重试');
    assert.equal(ms, 10_745_000);
  });

  it('builds one clean OpenAI-compatible 429', () => {
    const response = buildOpenAIRateLimitError({ model: 'glm-5.2', retryAfterMs: 10_745_000 });
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '10745');
    assert.equal(response.body.error.type, 'rate_limit');
    assert.equal(response.body.error.code, 'model_rate_limited');
  });
});
