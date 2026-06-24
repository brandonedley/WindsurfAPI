import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRouteGetChatMessageTools, mapGetChatMessageResultToChoice, handleChatCompletions } from '../src/handlers/chat.js';
import { supportsToolCalls } from '../src/models.js';

const tools = [
  { type: 'function', function: { name: 'exec', description: 'run', parameters: { type: 'object', properties: {} } } },
];

test('supportsToolCalls is true for cascade-uid models, false for unknown', () => {
  assert.equal(supportsToolCalls('glm-5.2'), true);
  assert.equal(supportsToolCalls('glm-5-2'), true); // alias
  assert.equal(supportsToolCalls('nonexistent-model'), false);
});

test('routes only when flag=1 AND model supports tool calls AND tools[] present', () => {
  const base = { env: { WINDSURFAPI_GETCHATMESSAGE_TOOLS: '1' }, modelKey: 'glm-5.2', tools };
  assert.equal(shouldRouteGetChatMessageTools(base), true);

  // flag off
  assert.equal(
    shouldRouteGetChatMessageTools({ ...base, env: { WINDSURFAPI_GETCHATMESSAGE_TOOLS: '0' } }),
    false,
  );
  // flag absent
  assert.equal(shouldRouteGetChatMessageTools({ ...base, env: {} }), false);
  // no tools
  assert.equal(shouldRouteGetChatMessageTools({ ...base, tools: [] }), false);
  assert.equal(shouldRouteGetChatMessageTools({ ...base, tools: undefined }), false);
  // model without tool support
  assert.equal(shouldRouteGetChatMessageTools({ ...base, modelKey: 'unknown-x' }), false);
});

test('maps a tool-call result to an OpenAI choice with finish_reason=tool_calls', () => {
  const parsed = {
    text: '',
    stopReason: 10,
    toolCalls: [{ id: 'tool_1', name: 'exec', argumentsJson: '{"command":"echo hi"}' }],
    openaiToolCalls: [{ id: 'tool_1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo hi"}' } }],
  };
  const choice = mapGetChatMessageResultToChoice(parsed);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].function.name, 'exec');
});

test('maps parallel tool calls', () => {
  const parsed = {
    text: '',
    stopReason: 10,
    toolCalls: [
      { id: 'a', name: 'exec', argumentsJson: '{"command":"a"}' },
      { id: 'b', name: 'read', argumentsJson: '{"path":"b"}' },
    ],
    openaiToolCalls: [
      { id: 'a', type: 'function', function: { name: 'exec', arguments: '{"command":"a"}' } },
      { id: 'b', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
    ],
  };
  const choice = mapGetChatMessageResultToChoice(parsed);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls.length, 2);
});

test('maps a text-only result to finish_reason=stop with content', () => {
  const parsed = { text: 'Hello world', stopReason: 1, toolCalls: [], openaiToolCalls: [] };
  const choice = mapGetChatMessageResultToChoice(parsed);
  assert.equal(choice.finish_reason, 'stop');
  assert.equal(choice.message.content, 'Hello world');
  assert.equal(choice.message.tool_calls, undefined);
});

test('handler routes through the native transport when flag+capability+tools (mock transport)', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    let transportCalls = 0;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async ({ messages, tools: t, model }) => {
        transportCalls += 1;
        assert.equal(model.uid, 'glm-5-2');
        assert.equal(t.length, 1);
        assert.ok(messages.some((m) => m.role === 'user'));
        return {
          text: '',
          stopReason: 10,
          toolCalls: [{ id: 'tool_1', name: 'exec', argumentsJson: '{"command":"echo LIVE_OK"}' }],
          openaiToolCalls: [{ id: 'tool_1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo LIVE_OK"}' } }],
        };
      },
    };
    const res = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'echo LIVE_OK' }], tools },
      ctx,
    );
    assert.equal(transportCalls, 1, 'native transport invoked exactly once');
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].finish_reason, 'tool_calls');
    assert.equal(res.body.choices[0].message.tool_calls[0].function.name, 'exec');
    assert.equal(res.body.object, 'chat.completion');
  } finally {
    if (prev === undefined) delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
    else process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
  }
});

test('handler does NOT route to native transport when flag is OFF (legacy path unchanged)', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  try {
    let transportCalls = 0;
    const ctx = {
      callerKey: 'k',
      // Legacy path uses the real module-level getApiKey; with no accounts
      // configured in the test env it returns null and the handler produces an
      // exhaustion response. The point of this test is that the native
      // transport is NEVER invoked while the flag is off.
      waitForAccount: async () => null,
      __nativeToolsTransport: async () => { transportCalls += 1; return { text: '', stopReason: 10, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'echo LIVE_OK' }], tools },
      ctx,
    );
    assert.equal(transportCalls, 0, 'native transport NEVER invoked with flag off');
    assert.ok(res && res.status, 'legacy path produced a response');
  } finally {
    if (prev !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
  }
});

test('handler maps parallel native tool calls and tool-result continuation', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    let seenMessages = null;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async ({ messages }) => {
        seenMessages = messages;
        return {
          text: '',
          stopReason: 10,
          toolCalls: [
            { id: 'a', name: 'exec', argumentsJson: '{"command":"a"}' },
            { id: 'b', name: 'exec', argumentsJson: '{"command":"b"}' },
          ],
          openaiToolCalls: [
            { id: 'a', type: 'function', function: { name: 'exec', arguments: '{"command":"a"}' } },
            { id: 'b', type: 'function', function: { name: 'exec', arguments: '{"command":"b"}' } },
          ],
        };
      },
    };
    // include a prior assistant tool_call + tool result to prove history rides through
    const res = await handleChatCompletions(
      {
        model: 'glm-5.2',
        messages: [
          { role: 'user', content: 'do both' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'prev', type: 'function', function: { name: 'exec', arguments: '{"command":"x"}' } }] },
          { role: 'tool', tool_call_id: 'prev', content: 'done' },
          { role: 'user', content: 'now both' },
        ],
        tools,
      },
      ctx,
    );
    assert.equal(res.body.choices[0].message.tool_calls.length, 2);
    assert.ok(seenMessages.some((m) => m.role === 'tool'), 'tool-result history forwarded');
    assert.ok(seenMessages.some((m) => m.role === 'assistant' && m.tool_calls), 'assistant tool_calls history forwarded');
  } finally {
    if (prev === undefined) delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
    else process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
  }
});

test('handler returns a clean error on native transport failure (no legacy fallthrough)', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => {
        const e = new Error('quota exhausted');
        e.status = 429;
        throw e;
      },
    };
    const res = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }], tools },
      ctx,
    );
    assert.equal(res.status, 429);
    assert.equal(res.body.error.type, 'rate_limit_exceeded');
  } finally {
    if (prev === undefined) delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
    else process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
  }
});

test('flag-off decision is independent of model/tools so legacy path is unchanged', () => {
  // With the flag off, no combination of model/tools should ever route.
  for (const modelKey of ['glm-5.2', 'unknown-x']) {
    for (const t of [tools, [], undefined]) {
      assert.equal(
        shouldRouteGetChatMessageTools({ env: {}, modelKey, tools: t }),
        false,
      );
    }
  }
});
