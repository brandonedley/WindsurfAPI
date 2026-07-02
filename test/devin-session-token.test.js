import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGetSelfDevinSessionTokenRequest,
  fetchSelfDevinSessionToken,
  isDevinSessionToken,
  parseGetSelfDevinSessionTokenResponse,
  GET_SELF_DEVIN_SESSION_TOKEN_PATH,
} from '../src/devin-session-token.js';
import { writeStringField, parseFields, getField } from '../src/proto.js';

test('isDevinSessionToken detects Desktop token prefix', () => {
  assert.equal(isDevinSessionToken('devin-session-token$abc'), true);
  assert.equal(isDevinSessionToken('ott$abc'), false);
  assert.equal(isDevinSessionToken(''), false);
});

test('buildGetSelfDevinSessionTokenRequest wraps metadata in field 1', () => {
  const body = buildGetSelfDevinSessionTokenRequest('test-api-key', {
    clientVersion: '3.0.12',
    sessionId: '00000000-0000-4000-8000-000000000000',
  });
  const fields = parseFields(body);
  const metadata = getField(fields, 1, 2);
  assert.ok(metadata, 'expected metadata field 1');

  const metadataFields = parseFields(metadata.value);
  assert.equal(getField(metadataFields, 1, 2).value.toString('utf8'), 'windsurf');
  assert.equal(getField(metadataFields, 2, 2).value.toString('utf8'), '3.0.12');
  assert.equal(getField(metadataFields, 3, 2).value.toString('utf8'), 'test-api-key');
  assert.equal(getField(metadataFields, 10, 2).value.toString('utf8'), '00000000-0000-4000-8000-000000000000');
});

test('parseGetSelfDevinSessionTokenResponse reads session_token field 1', () => {
  const payload = writeStringField(1, 'devin-session-token$abc123');
  assert.equal(parseGetSelfDevinSessionTokenResponse(payload), 'devin-session-token$abc123');
});

test('fetchSelfDevinSessionToken uses raw unary application/proto Connect request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return writeStringField(1, 'devin-session-token$abc123');
      },
    };
  };

  const token = await fetchSelfDevinSessionToken('test-api-key', {
    apiServerUrl: 'https://server.codeium.com',
    clientVersion: '3.0.12',
    sessionId: '00000000-0000-4000-8000-000000000000',
    fetchImpl,
  });

  assert.equal(token, 'devin-session-token$abc123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://server.codeium.com${GET_SELF_DEVIN_SESSION_TOKEN_PATH}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/proto');
  assert.equal(calls[0].init.headers['Accept'], 'application/proto');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'test-api-key');
  assert.ok(Buffer.isBuffer(calls[0].init.body));
});

test('fetchSelfDevinSessionToken returns existing Devin session tokens without network', async () => {
  let called = false;
  const token = await fetchSelfDevinSessionToken('devin-session-token$already', {
    fetchImpl: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(token, 'devin-session-token$already');
  assert.equal(called, false);
});
