import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getChatMessageWithTools, GetChatMessageCloudError, _clearDevinTokenCache } from '../src/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'getchatmessage');

const RESPONSE_OK = readFileSync(join(FIX, 'glm52-tool-response-replayed.connectproto.bin'));

function makeFetch({ status = 200, body = RESPONSE_OK, capture } = {}) {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/connect+proto' },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
];

const account = { apiKey: 'devin-already-a-token', apiServerUrl: 'https://server.codeium.com' };

test('POSTs to the cloud GetChatMessage endpoint with Basic auth and connect headers', async () => {
  const capture = {};
  const result = await getChatMessageWithTools({
    account,
    messages: [{ role: 'user', content: 'echo LIVE_OK' }],
    tools,
    model: 'glm-5-2',
    fetchImpl: makeFetch({ capture }),
    tokenFetcher: async () => 'devin-minted-token',
  });

  assert.match(capture.url, /\/exa\.api_server_pb\.ApiServerService\/GetChatMessage$/);
  assert.equal(capture.init.method, 'POST');
  assert.equal(capture.init.headers['authorization'], 'Basic devin-minted-token');
  assert.equal(capture.init.headers['content-type'], 'application/connect+proto');
  assert.equal(capture.init.headers['connect-protocol-version'], '1');
  assert.ok(Buffer.isBuffer(capture.init.body) || capture.init.body instanceof Uint8Array);

  // parsed tool call surfaces
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'exec');
  assert.deepEqual(JSON.parse(result.toolCalls[0].argumentsJson), { command: 'echo CAPTURE_OK_7' });
  assert.equal(result.stopReason, 10);
  // OpenAI-shaped tool_calls available
  assert.equal(result.openaiToolCalls[0].function.name, 'exec');
});

test('caches the minted token across calls for the same account', async () => {
  let minted = 0;
  const fetcher = async () => {
    minted += 1;
    return `tok-${minted}`;
  };
  const acct = { apiKey: 'rawkey', apiServerUrl: 'https://server.codeium.com' };
  await getChatMessageWithTools({ account: acct, messages: [{ role: 'user', content: 'a' }], tools, model: 'glm-5-2', fetchImpl: makeFetch(), tokenFetcher: fetcher });
  await getChatMessageWithTools({ account: acct, messages: [{ role: 'user', content: 'b' }], tools, model: 'glm-5-2', fetchImpl: makeFetch(), tokenFetcher: fetcher });
  assert.equal(minted, 1, 'token minted once and reused');
});

test('maps a non-200 to a clean GetChatMessageCloudError', async () => {
  await assert.rejects(
    () =>
      getChatMessageWithTools({
        account,
        messages: [{ role: 'user', content: 'x' }],
        tools,
        model: 'glm-5-2',
        fetchImpl: makeFetch({ status: 429, body: Buffer.from('rate limited') }),
        tokenFetcher: async () => 't',
      }),
    (err) => {
      assert.ok(err instanceof GetChatMessageCloudError);
      assert.equal(err.status, 429);
      return true;
    },
  );
});

test('maps an error trailer to a clean error', async () => {
  // a data frame then an error trailer frame
  const trailer = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00]),
    Buffer.from([0x38]),
    Buffer.from('{"error":{"code":"resource_exhausted","message":"quota"}}'),
  ]);
  // fix the length prefix
  const errBody = makeErrorTrailerBody('{"error":{"code":"resource_exhausted","message":"quota"}}');
  await assert.rejects(
    () =>
      getChatMessageWithTools({
        account,
        messages: [{ role: 'user', content: 'x' }],
        tools,
        model: 'glm-5-2',
        fetchImpl: makeFetch({ status: 200, body: errBody }),
        tokenFetcher: async () => 't',
      }),
    (err) => {
      assert.ok(err instanceof GetChatMessageCloudError);
      assert.match(err.message, /quota|resource_exhausted/);
      return true;
    },
  );
});

function makeErrorTrailerBody(json) {
  const payload = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(5);
  header[0] = 0x02;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// ─── Regression: devin session-token cache TTL + eviction (fix #4) ───

test('caches the session token across calls, re-mints after a 401 eviction', async () => {
  _clearDevinTokenCache();
  let mints = 0;
  const tokenFetcher = async () => { mints += 1; return `devin-token-${mints}`; };
  const acct = { apiKey: 'devin-acct-A', apiServerUrl: 'https://server.codeium.com' };
  const call = (status) => getChatMessageWithTools({
    account: acct,
    messages: [{ role: 'user', content: 'x' }],
    tools, model: 'glm-5-2',
    fetchImpl: makeFetch({ status }),
    tokenFetcher,
  });

  await call(200);
  await call(200);
  assert.equal(mints, 1, 'token reused within TTL — minted once');

  // A 401 must evict the cached token...
  await assert.rejects(() => call(401), (e) => e instanceof GetChatMessageCloudError && e.status === 401);
  // ...so the next call re-mints.
  await call(200);
  assert.equal(mints, 2, 'stale token evicted on 401, re-minted on next call');
});

test('does NOT evict the token on a 429 (rate-limit is account-level, token still valid)', async () => {
  _clearDevinTokenCache();
  let mints = 0;
  const tokenFetcher = async () => { mints += 1; return `devin-token-${mints}`; };
  const acct = { apiKey: 'devin-acct-B', apiServerUrl: 'https://server.codeium.com' };
  const call = (status) => getChatMessageWithTools({
    account: acct, messages: [{ role: 'user', content: 'x' }], tools, model: 'glm-5-2',
    fetchImpl: makeFetch({ status }), tokenFetcher,
  });
  await call(200);
  await assert.rejects(() => call(429));
  await call(200);
  assert.equal(mints, 1, '429 should not evict the session token');
});
