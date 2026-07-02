import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDevinCloudAcpUrl,
  buildInitializeRequest,
  redactTokenFromUrl,
  runDevinCloudAcpInitializeSmoke,
} from '../src/devin-cloud-acp.js';

class MockWebSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(payload) {
    this.sent.push(payload);
    const message = JSON.parse(payload);
    if (message.method === 'initialize') {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'devin', title: 'Devin', version: 'test' },
            agentCapabilities: {
              promptCapabilities: { audio: false, embeddedContext: false, image: false },
              sessionCapabilities: {},
            },
            authMethods: [],
          },
        }),
      })));
    }
  }

  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

test('buildDevinCloudAcpUrl builds Desktop-compatible authenticated URL', () => {
  const url = buildDevinCloudAcpUrl('devin-session-token$abc123', { webappHost: 'app.devin.ai' });
  assert.equal(url, 'wss://app.devin.ai/api/acp/live?token=session-token%24abc123');
  assert.equal(redactTokenFromUrl(url), 'wss://app.devin.ai/api/acp/live?token=%3Credacted%3E');
});

test('buildDevinCloudAcpUrl uses ws for localhost hosts', () => {
  const url = buildDevinCloudAcpUrl('devin-session-token$abc123', { webappHost: 'localhost:7777' });
  assert.equal(url, 'ws://localhost:7777/api/acp/live?token=session-token%24abc123');
});

test('buildInitializeRequest sends explicit no-fs/no-terminal client capabilities', () => {
  const req = buildInitializeRequest({ id: 42, clientVersion: '1.2.3' });
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.id, 42);
  assert.equal(req.method, 'initialize');
  assert.equal(req.params.protocolVersion, 1);
  assert.deepEqual(req.params.clientCapabilities, {
    auth: { terminal: false },
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.equal(req.params.clientInfo.name, 'windsurf-api-lab');
  assert.equal(req.params.clientInfo.version, '1.2.3');
});

test('runDevinCloudAcpInitializeSmoke sends initialize only and does not create session/prompt', async () => {
  MockWebSocket.instances = [];
  const result = await runDevinCloudAcpInitializeSmoke('devin-session-token$abc123', {
    WebSocketImpl: MockWebSocket,
    webappHost: 'app.devin.ai',
    openTimeoutMs: 1000,
    responseTimeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.tokenPrefixOk, true);
  assert.equal(result.tokenLength, 'devin-session-token$abc123'.length);
  assert.equal(result.sentInitialize, true);
  assert.equal(result.sentPrompt, false);
  assert.equal(result.createdSession, false);
  assert.equal(result.initialize.agentName, 'devin');
  assert.equal(MockWebSocket.instances.length, 1);
  assert.equal(MockWebSocket.instances[0].closed, true);

  const sentMethods = MockWebSocket.instances[0].sent.map((payload) => JSON.parse(payload).method);
  assert.deepEqual(sentMethods, ['initialize']);
});
