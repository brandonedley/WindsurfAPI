import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseGetChatMessageResponse,
  writeResponseDataFrame,
  writeResponseTrailerFrame,
  STOP_REASON_TOOL_USE,
} from '../src/getchatmessage.js';
import { writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'getchatmessage');

test('parses the replayed tool-call response fixture into exactly one tool call', () => {
  const bytes = readFileSync(join(FIX, 'glm52-tool-response-replayed.connectproto.bin'));
  const result = parseGetChatMessageResponse(bytes);
  assert.equal(result.toolCalls.length, 1, 'exactly one tool call');
  const tc = result.toolCalls[0];
  assert.equal(tc.name, 'exec');
  assert.equal(tc.id, 'chatcmpl-tool-9af8c9056312ced1');
  assert.deepEqual(JSON.parse(tc.argumentsJson), { command: 'echo CAPTURE_OK_7' });
  assert.equal(result.stopReason, STOP_REASON_TOOL_USE);
  assert.equal(STOP_REASON_TOOL_USE, 10);
  assert.equal(result.errorTrailer, null, 'success trailer means no error');
  assert.equal(result.text, '', 'no assistant text in this response');
});

test('parses the original captured response fixture identically', () => {
  const bytes = readFileSync(join(FIX, 'glm52-tool-response-original.connectproto.bin'));
  const result = parseGetChatMessageResponse(bytes);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'exec');
  assert.deepEqual(JSON.parse(result.toolCalls[0].argumentsJson), { command: 'echo CAPTURE_OK_7' });
  assert.equal(result.stopReason, 10);
});

function buildToolCallDelta({ id, name, args }) {
  const parts = [];
  if (id) parts.push(writeStringField(1, id));
  if (name) parts.push(writeStringField(2, name));
  if (args !== undefined) parts.push(writeStringField(3, args));
  return writeMessageField(6, Buffer.concat(parts));
}

test('concatenates streamed argument fragments and latches id+name from the first delta', () => {
  const frames = [
    writeResponseDataFrame(buildToolCallDelta({ id: 'tool_1', name: 'exec' })),
    writeResponseDataFrame(buildToolCallDelta({ args: '{"command": "' })),
    writeResponseDataFrame(buildToolCallDelta({ args: 'echo hi' })),
    writeResponseDataFrame(buildToolCallDelta({ args: '"}' })),
    writeResponseDataFrame(writeVarintField(5, 10)),
    writeResponseTrailerFrame('{}'),
  ];
  const result = parseGetChatMessageResponse(Buffer.concat(frames));
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'tool_1');
  assert.equal(result.toolCalls[0].name, 'exec');
  assert.equal(result.toolCalls[0].argumentsJson, '{"command": "echo hi"}');
  assert.equal(result.stopReason, 10);
});

test('parses parallel tool calls into separate entries by id', () => {
  const frames = [
    writeResponseDataFrame(buildToolCallDelta({ id: 'tool_a', name: 'exec' })),
    writeResponseDataFrame(buildToolCallDelta({ args: '{"command":"a"}' })),
    writeResponseDataFrame(buildToolCallDelta({ id: 'tool_b', name: 'read' })),
    writeResponseDataFrame(buildToolCallDelta({ args: '{"path":"b"}' })),
    writeResponseDataFrame(writeVarintField(5, 10)),
    writeResponseTrailerFrame('{}'),
  ];
  const result = parseGetChatMessageResponse(Buffer.concat(frames));
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].id, 'tool_a');
  assert.equal(result.toolCalls[0].name, 'exec');
  assert.equal(result.toolCalls[0].argumentsJson, '{"command":"a"}');
  assert.equal(result.toolCalls[1].id, 'tool_b');
  assert.equal(result.toolCalls[1].name, 'read');
  assert.equal(result.toolCalls[1].argumentsJson, '{"path":"b"}');
});

test('accumulates delta_text for a text-only response', () => {
  const frames = [
    writeResponseDataFrame(writeStringField(3, 'Hello, ')),
    writeResponseDataFrame(writeStringField(3, 'world!')),
    writeResponseDataFrame(writeVarintField(5, 1)),
    writeResponseTrailerFrame('{}'),
  ];
  const result = parseGetChatMessageResponse(Buffer.concat(frames));
  assert.equal(result.text, 'Hello, world!');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.stopReason, 1);
  assert.equal(result.errorTrailer, null);
});

test('surfaces an error trailer frame', () => {
  const frames = [
    writeResponseDataFrame(writeStringField(3, 'partial')),
    writeResponseTrailerFrame('{"error":{"code":"resource_exhausted","message":"quota"}}'),
  ];
  const result = parseGetChatMessageResponse(Buffer.concat(frames));
  assert.ok(result.errorTrailer, 'errorTrailer populated');
  assert.equal(result.errorTrailer.error.code, 'resource_exhausted');
});

test('accepts an async iterable of chunks (streaming transport)', async () => {
  const frames = [
    writeResponseDataFrame(buildToolCallDelta({ id: 'tool_1', name: 'exec' })),
    writeResponseDataFrame(buildToolCallDelta({ args: '{"command":"x"}' })),
    writeResponseDataFrame(writeVarintField(5, 10)),
    writeResponseTrailerFrame('{}'),
  ];
  // chunk the frames at arbitrary boundaries to exercise the buffering loop
  const full = Buffer.concat(frames);
  async function* gen() {
    let i = 0;
    while (i < full.length) {
      const step = 7;
      yield full.subarray(i, Math.min(i + step, full.length));
      i += step;
    }
  }
  const result = await parseGetChatMessageResponse(gen());
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'exec');
  assert.equal(result.toolCalls[0].argumentsJson, '{"command":"x"}');
  assert.equal(result.stopReason, 10);
});
