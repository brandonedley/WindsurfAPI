import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideContextBudget, measureCompatRequest, buildOpenAIContextBudgetError } from '../src/hermes-devin/context-budget.js';
import { getHermesDevinModelPolicy } from '../src/hermes-devin/model-policy.js';

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

describe('Hermes Devin context budget', () => {
  it('measures message and tool payload size', () => {
    const m = measureCompatRequest({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      tools: [tool('terminal'), tool('read_file')],
      modelPolicy: getHermesDevinModelPolicy('glm-5.2', 'zhipu'),
    });
    assert.equal(m.systemChars, 3);
    assert.equal(m.lastUserChars, 5);
    assert.equal(m.toolCount, 2);
    assert.ok(m.toolSchemaChars > 0);
  });

  it('rejects the known huge-prompt + broad-tool GLM quota-burn shape before upstream dispatch', () => {
    const messages = [
      { role: 'system', content: 's'.repeat(31_944) },
      { role: 'user', content: 'u'.repeat(133_057) },
    ];
    const tools = Array.from({ length: 32 }, (_, i) => tool(`tool_${i}`));
    const policy = getHermesDevinModelPolicy('glm-5.2', 'zhipu');
    const decision = decideContextBudget(measureCompatRequest({ messages, tools, modelPolicy: policy }), policy);
    assert.equal(decision.action, 'reject');
    assert.equal(decision.status, 413);
    assert.equal(decision.reason, 'fragile_model_huge_prompt_with_broad_tools');
    const err = buildOpenAIContextBudgetError(decision, 'glm-5.2');
    assert.equal(err.status, 413);
    assert.equal(err.body.error.type, 'context_length_exceeded');
  });

  it('allows small prompts with broad tools', () => {
    const messages = [{ role: 'user', content: 'Use terminal to print ok' }];
    const tools = Array.from({ length: 32 }, (_, i) => tool(`tool_${i}`));
    const policy = getHermesDevinModelPolicy('glm-5.2', 'zhipu');
    const decision = decideContextBudget(measureCompatRequest({ messages, tools, modelPolicy: policy }), policy);
    assert.equal(decision.action, 'allow');
  });
});
