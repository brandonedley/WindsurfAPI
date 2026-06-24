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

// ─── Regression: adversarial-review fixes (flag-ON safety) ───

test('does NOT route deprecated / special-agent models even with flag+tools (fix #6)', () => {
  const env = { WINDSURFAPI_GETCHATMESSAGE_TOOLS: '1' };
  // adaptive/arena-* carry a modelUid (supportsToolCalls=true) but are
  // deprecated special_agent models with their own routing — must be excluded.
  for (const modelKey of ['adaptive', 'arena-fast', 'arena-smart']) {
    assert.equal(supportsToolCalls(modelKey), true, `${modelKey} has a uid`);
    assert.equal(shouldRouteGetChatMessageTools({ env, modelKey, tools }), false, `${modelKey} must not route`);
  }
});

test('mapGetChatMessageResultToChoice drops tool calls not in declared tools[] (fix #2 allowlist)', () => {
  const parsed = {
    stopReason: 10,
    toolCalls: [
      { id: 't1', name: 'exec', argumentsJson: '{"command":"echo hi"}' },
      { id: 't2', name: 'Bash', argumentsJson: '{"command":"rm -rf /"}' }, // never declared
    ],
  };
  const choice = mapGetChatMessageResultToChoice(parsed, tools); // tools declares only 'exec'
  const names = (choice.message.tool_calls || []).map(c => c.function.name);
  assert.deepEqual(names, ['exec']);
});

test('mapGetChatMessageResultToChoice sanitizes workspace paths in arguments (fix #2 sanitize)', () => {
  const parsed = {
    stopReason: 10,
    toolCalls: [{ id: 't1', name: 'exec', argumentsJson: '{"path":"/home/user/projects/workspace-abc123/secret.txt"}' }],
  };
  const choice = mapGetChatMessageResultToChoice(parsed, tools);
  const args = choice.message.tool_calls[0].function.arguments;
  assert.ok(!/workspace-abc123/.test(args), `workspace path should be redacted, got: ${args}`);
});

test('mapGetChatMessageResultToChoice with no allowlist still returns calls (back-compat)', () => {
  const parsed = { stopReason: 10, toolCalls: [{ id: 't1', name: 'whatever', argumentsJson: '{}' }] };
  const choice = mapGetChatMessageResultToChoice(parsed); // no tools arg
  assert.equal(choice.message.tool_calls.length, 1);
});

test('native route returns clean exhaustion (no legacy fall-through) when no account available (#2)', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    let transportCalls = 0;
    const ctx = {
      callerKey: 'k',
      getApiKey: () => null,            // no immediate account
      waitForAccount: async () => null, // none frees up
      __nativeToolsTransport: async () => { transportCalls += 1; return { text: '', stopReason: 10, toolCalls: [], openaiToolCalls: [] }; },
    };
    const res = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'echo x' }], tools },
      ctx,
    );
    assert.equal(transportCalls, 0, 'no account => native transport not invoked');
    assert.ok(res.status === 429 || res.status === 503, `clean rate-limit/exhaustion expected, got ${res.status}`);
    assert.ok(['rate_limit_exceeded', 'pool_exhausted'].includes(res.body.error.type), `clean error type, got ${res.body.error.type}`);
    // A 503 from the native block names the transport — proves we did NOT fall
    // through to the legacy emulation machinery.
    if (res.status === 503) assert.match(res.body.error.message, /native tool transport/);
  } finally {
    if (prev !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});

test('transient upstream trailer => retryable 502 (not treated as rate limit); real 429 => 429', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    const baseCtx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
    };
    // (a) transient model-side error trailer — must surface as a retryable
    // upstream_error, NOT rate_limit_exceeded (so it won't read as cooldown).
    const transient = Object.assign(new Error('GetChatMessage error trailer: provider experiencing issues'), { errorTrailer: { error: { code: 'unknown' } } });
    const resT = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }], tools },
      { ...baseCtx, __nativeToolsTransport: async () => { throw transient; } },
    );
    assert.equal(resT.status, 502, `transient trailer => 502, got ${resT.status}`);
    assert.equal(resT.body.error.type, 'upstream_error');

    // (b) a real HTTP 429 => 429 rate_limit_exceeded.
    const rl = Object.assign(new Error('HTTP 429'), { status: 429 });
    const res429 = await handleChatCompletions(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }], tools },
      { ...baseCtx, __nativeToolsTransport: async () => { throw rl; } },
    );
    assert.equal(res429.status, 429);
    assert.equal(res429.body.error.type, 'rate_limit_exceeded');
  } finally {
    if (prev !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});

test('native route honors stream:true => SSE chunks with tool_calls + [DONE]', async () => {
  const prev = process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = '1';
  try {
    const ctx = {
      callerKey: 'k',
      getApiKey: () => ({ apiKey: 'devin-tok', apiServerUrl: 'https://server.codeium.com' }),
      __nativeToolsTransport: async () => ({
        text: '', stopReason: 10,
        toolCalls: [{ id: 't1', name: 'exec', argumentsJson: '{"command":"echo hi"}' }],
        openaiToolCalls: [{ id: 't1', type: 'function', function: { name: 'exec', arguments: '{"command":"echo hi"}' } }],
      }),
    };
    const res = await handleChatCompletions(
      { model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'x' }], tools },
      ctx,
    );
    assert.equal(res.stream, true, 'must return a streaming response for stream:true');
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    let out = '';
    const fakeRes = { writableEnded: false, write(s) { out += s; }, end() { this.writableEnded = true; } };
    await res.handler(fakeRes);
    assert.match(out, /chat\.completion\.chunk/, 'emits chunk objects');
    assert.match(out, /exec/, 'streams the tool call');
    assert.match(out, /"finish_reason":"tool_calls"/, 'final chunk has tool_calls finish_reason');
    assert.match(out, /data: \[DONE\]/, 'terminates with [DONE]');
  } finally {
    if (prev !== undefined) process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS = prev;
    else delete process.env.WINDSURFAPI_GETCHATMESSAGE_TOOLS;
  }
});
