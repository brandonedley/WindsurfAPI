import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleChatCompletions } from '../src/handlers/chat.js';

describe('Hermes Devin ACP selectable chat backend', () => {
  it('does not run ACP when the explicit flag is absent', async () => {
    let acpCalls = 0;
    const result = await handleChatCompletions({
      model: 'kimi-k2-6',
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      waitForAccount: async () => ({ id: 'acct-1', apiKey: 'upstream-key', apiServerUrl: 'https://server.self-serve.windsurf.com' }),
      hermesDevinAcp: {
        env: {},
        runAcp: async () => { acpCalls++; return { text: 'bad' }; },
      },
    });

    assert.notEqual(result.status, 200);
    assert.equal(acpCalls, 0);
  });

  it('routes non-streaming chat through ACP only when explicitly enabled', async () => {
    let seenPrompt = '';
    const result = await handleChatCompletions({
      model: 'kimi-k2-6',
      messages: [{ role: 'user', content: 'say ok' }],
    }, {
      waitForAccount: async () => ({ id: 'acct-1', apiKey: 'upstream-key', apiServerUrl: 'https://server.self-serve.windsurf.com' }),
      hermesDevinAcp: {
        env: { HERMES_DEVIN_ACP_BACKEND: '1' },
        runAcp: async (prompt: string, opts: { modelKey: string; apiKey: string; apiServerUrl: string }) => {
          seenPrompt = prompt;
          assert.equal(opts.modelKey, 'kimi-k2-6');
          assert.equal(opts.apiKey, 'upstream-key');
          assert.equal(opts.apiServerUrl, 'https://server.self-serve.windsurf.com');
          return { text: 'OK', usage: { inputTokens: 3, outputTokens: 1 } };
        },
      },
    });

    assert.equal(result.status, 200);
    const body = (result as any).body;
    assert.equal(body.model, 'kimi-k2-6');
    assert.equal(body.choices[0].message.content, 'OK');
    assert.equal(body.usage.total_tokens, 4);
    assert.match(seenPrompt, /user: say ok/);
  });
});
