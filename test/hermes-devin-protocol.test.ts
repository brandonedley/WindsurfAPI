import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseHermesDevinModelOutput,
  prepareHermesDevinRequest,
} from '../src/hermes-devin/adapter.js';

function tool(name: string, properties: Record<string, { type: string }> = { input: { type: 'string' } }, required = Object.keys(properties)) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties, required },
    },
  };
}

function terminalTool() {
  return tool('terminal', { command: { type: 'string' } }, ['command']);
}

describe('Hermes Devin strict model-output protocol', () => {
  it('accepts native OpenAI tool_calls for declared tools', () => {
    const prepared = prepareHermesDevinRequest({
      requestId: 'proto-native-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [terminalTool()],
      stream: false,
      displayModel: 'glm-5.2',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error('expected prepared request');

    const parsed = parseHermesDevinModelOutput({
      requestId: 'proto-native-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      text: '',
      nativeToolCalls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'terminal', arguments: '{"command":"pwd"}' },
      }],
      declaredTools: [terminalTool()],
      policy: prepared.policy,
    });

    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('expected parsed output');
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].function.name, 'terminal');
    assert.equal(parsed.message.tool_calls?.[0].function.arguments, '{"command":"pwd"}');
  });

  it('rejects narrative-only tool intent instead of fabricating a terminal call', () => {
    const prepared = prepareHermesDevinRequest({
      requestId: 'proto-narrative-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      messages: [{ role: 'user', content: 'Use the terminal tool to run pwd.' }],
      tools: [terminalTool()],
      stream: true,
      displayModel: 'glm-5.2',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error('expected prepared request');

    const parsed = parseHermesDevinModelOutput({
      requestId: 'proto-narrative-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      text: "I'll run the terminal command now.",
      declaredTools: [terminalTool()],
      policy: prepared.policy,
    });

    assert.equal(parsed.ok, false);
    if (parsed.ok) throw new Error('expected adapter error');
    assert.equal(parsed.response.status, 400);
    assert.equal(parsed.response.body.error.type, 'adapter_error');
    assert.equal(parsed.response.body.error.code, 'tool_call_required_but_not_emitted');
  });

  it('rejects undeclared native tool calls', () => {
    const prepared = prepareHermesDevinRequest({
      requestId: 'proto-undeclared-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [terminalTool()],
      stream: false,
      displayModel: 'glm-5.2',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error('expected prepared request');

    const parsed = parseHermesDevinModelOutput({
      requestId: 'proto-undeclared-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      text: '',
      nativeToolCalls: [{
        id: 'call_2',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"/tmp/x","content":"x"}' },
      }],
      declaredTools: [terminalTool()],
      policy: prepared.policy,
    });

    assert.equal(parsed.ok, false);
    if (parsed.ok) throw new Error('expected adapter error');
    assert.equal(parsed.response.status, 422);
    assert.equal(parsed.response.body.error.code, 'tool_not_declared');
  });

  it('rejects malformed tool-call JSON arguments without repairing them', () => {
    const prepared = prepareHermesDevinRequest({
      requestId: 'proto-malformed-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [terminalTool()],
      stream: false,
      displayModel: 'glm-5.2',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error('expected prepared request');

    const parsed = parseHermesDevinModelOutput({
      requestId: 'proto-malformed-1',
      model: 'glm-5.2',
      provider: 'zhipu',
      text: '',
      nativeToolCalls: [{
        id: 'call_3',
        type: 'function',
        function: { name: 'terminal', arguments: '{command:pwd}' },
      }],
      declaredTools: [terminalTool()],
      policy: prepared.policy,
    });

    assert.equal(parsed.ok, false);
    if (parsed.ok) throw new Error('expected adapter error');
    assert.equal(parsed.response.status, 422);
    assert.equal(parsed.response.body.error.code, 'tool_arguments_invalid_json');
  });
});
