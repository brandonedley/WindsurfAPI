import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSessionNewRequest,
  buildSessionPromptRequest,
  executeHermesDevinAcpChat,
  openAIMessageToDevinPromptText,
  normalizeAcpNotificationsToOpenAI,
  normalizeAcpToolRequestToOpenAIToolCall,
  shouldUseHermesDevinAcpBackend,
} from '../src/hermes-devin/acp-backend.js';

function declaredTool(name: string) {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {}, required: [] } } };
}

describe('Hermes Devin ACP backend payload shaping', () => {
  it('builds gated session/new and session/prompt JSON-RPC requests', () => {
    const sessionNew = buildSessionNewRequest({ id: 2, model: 'swe-1.6-fast' });
    const prompt = buildSessionPromptRequest({ id: 3, sessionId: 'session-1', prompt: 'hello' });

    assert.equal(sessionNew.method, 'session/new');
    assert.equal(sessionNew.params.model, 'swe-1.6-fast');
    assert.equal(prompt.method, 'session/prompt');
    assert.equal(prompt.params.sessionId, 'session-1');
    assert.deepEqual(prompt.params.prompt.content, [{ type: 'text', text: 'hello' }]);
  });

  it('flattens OpenAI messages into a text-only Devin prompt', () => {
    const text = openAIMessageToDevinPromptText([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'tool', name: 'terminal', content: 'ok' },
    ]);

    assert.match(text, /system: system rules/);
    assert.match(text, /user: do it/);
    assert.match(text, /tool terminal: ok/);
  });

  it('normalizes ACP assistant chunks and declared tool requests to OpenAI shapes', () => {
    const content = normalizeAcpNotificationsToOpenAI([
      { method: 'agent_message_chunk', params: { text: 'Hel' } },
      { method: 'agent_message_chunk', params: { chunk: 'lo' } },
      { method: 'agent_thought_chunk', params: { text: 'hidden' } },
    ]);
    assert.equal(content, 'Hello');

    const toolCall = normalizeAcpToolRequestToOpenAIToolCall(
      { method: 'tool/call', params: { name: 'terminal', arguments: { command: 'pwd' }, id: 'tc-1' } },
      [declaredTool('terminal')],
    );
    assert.equal(toolCall.function.name, 'terminal');
    assert.equal(toolCall.function.arguments, JSON.stringify({ command: 'pwd' }));
    assert.equal(normalizeAcpToolRequestToOpenAIToolCall({ method: 'tool/call', params: { name: 'memory' } }, [declaredTool('terminal')]), null);
  });

  it('keeps live ACP execution disabled unless the explicit Hermes flag is set', async () => {
    assert.equal(shouldUseHermesDevinAcpBackend({ model: 'gpt-5.4' }, {}), false);
    assert.equal(shouldUseHermesDevinAcpBackend({ model: 'gpt-5.4' }, { HERMES_DEVIN_ACP_BACKEND: '1' }), true);

    let runnerCalls = 0;
    const result = await executeHermesDevinAcpChat({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hello' }],
      account: { apiKey: 'upstream', apiServerUrl: 'https://server.self-serve.windsurf.com' },
      env: {},
    }, {
      runAcp: async () => { runnerCalls++; return { text: 'bad' }; },
    });
    assert.equal(result, null);
    assert.equal(runnerCalls, 0);
  });

  it('executes enabled ACP chat through an injected runner and returns OpenAI-compatible body', async () => {
    let seenPrompt = '';
    const result = await executeHermesDevinAcpChat({
      id: 'chatcmpl-test',
      created: 123,
      model: 'gpt-5.4',
      modelKey: 'gpt-5.4',
      messages: [{ role: 'user', content: 'say ok' }],
      account: { apiKey: 'upstream', apiServerUrl: 'https://server.self-serve.windsurf.com' },
      env: { HERMES_DEVIN_ACP_BACKEND: '1' },
    }, {
      runAcp: async (prompt: string, opts: { modelKey: string; apiKey: string; apiServerUrl: string }) => {
        seenPrompt = prompt;
        assert.equal(opts.modelKey, 'gpt-5.4');
        assert.equal(opts.apiKey, 'upstream');
        assert.equal(opts.apiServerUrl, 'https://server.self-serve.windsurf.com');
        return { text: 'OK', usage: { inputTokens: 2, outputTokens: 1 } };
      },
    });

    assert.equal(result?.status, 200);
    assert.equal(result?.body.id, 'chatcmpl-test');
    assert.equal(result?.body.choices[0].message.content, 'OK');
    assert.equal(result?.body.usage.prompt_tokens, 2);
    assert.equal(result?.body.usage.completion_tokens, 1);
    assert.match(seenPrompt, /user: say ok/);
  });
});
