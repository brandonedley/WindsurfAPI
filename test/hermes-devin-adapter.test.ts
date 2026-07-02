import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prepareHermesDevinRequest } from '../src/hermes-devin/adapter.js';

function tool(name: string, properties: Record<string, { type: string }> = { input: { type: 'string' } }) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties, required: Object.keys(properties) },
    },
  };
}

describe('Hermes Devin adapter shadow preparation', () => {
  it('returns policy, budget, gateway and trace without mutating request tools', () => {
    const tools = [
      tool('terminal', { command: { type: 'string' } }),
      tool('memory', { action: { type: 'string' }, content: { type: 'string' } }),
    ];
    const prepared = prepareHermesDevinRequest({
      requestId: 'req-adapter-1',
      modelKey: 'gpt-5.4',
      provider: 'gpt',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      nativeToolNames: ['terminal'],
    });

    assert.equal(prepared.budget.action, 'allow');
    assert.equal(prepared.gateway.certification.total, 2);
    assert.equal(prepared.gateway.native[0].name, 'terminal');
    assert.equal(prepared.gateway.emulated[0].name, 'memory');
    assert.deepEqual(prepared.effectiveTools, tools);
    assert.equal(prepared.trace.events.at(-1).state, 'tools_classified');
  });

  it('rejects fragile huge prompts before upstream dispatch', () => {
    const prepared = prepareHermesDevinRequest({
      requestId: 'req-adapter-2',
      modelKey: 'glm-5.1',
      provider: 'glm',
      messages: [{ role: 'user', content: 'x'.repeat(133_057) }],
      tools: Array.from({ length: 32 }, (_, i) => tool(`tool_${i}`)),
    });

    assert.equal(prepared.budget.action, 'reject');
    assert.equal(prepared.response.status, 413);
    assert.equal(prepared.trace.events.at(-1).state, 'failed_nonretryable');
  });
});
