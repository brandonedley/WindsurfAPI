import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleChatCompletions } from '../src/handlers/chat.js';

function tool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    },
  };
}

describe('Hermes Devin chat compatibility budget guard', () => {
  it('rejects huge GLM + full Hermes toolset before account/upstream dispatch', async () => {
    let accountTouched = false;
    const result = await handleChatCompletions({
      model: 'glm-5.2',
      stream: false,
      messages: [
        { role: 'system', content: 's'.repeat(31_944) },
        { role: 'user', content: 'u'.repeat(133_057) },
      ],
      tools: Array.from({ length: 32 }, (_, i) => tool(`tool_${i}`)),
    }, {
      callerKey: 'test-budget-guard',
      waitForAccount: async () => {
        accountTouched = true;
        throw new Error('should not reserve an account');
      },
    });

    assert.equal(result.status, 413);
    assert.equal(result.body.error.type, 'context_length_exceeded');
    assert.equal(result.body.error.code, 'fragile_model_huge_prompt_with_broad_tools');
    assert.equal(accountTouched, false);
  });
});
