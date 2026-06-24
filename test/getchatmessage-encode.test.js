import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildGetChatMessageRequest,
  REQUEST_TYPE_CASCADE,
  SOURCE,
} from '../src/getchatmessage.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'getchatmessage');

function stripConnect(buf) {
  // [1 flag][4-byte BE len][protobuf]
  assert.equal(buf[0], 0x00, 'connect flag byte must be 0x00 for a data frame');
  const len = buf.readUInt32BE(1);
  assert.equal(len + 5, buf.length, 'connect length prefix must match payload length');
  return buf.subarray(5, 5 + len);
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run a shell command and return its output.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: { command: { type: 'string', description: 'the command' } },
      },
    },
  },
];

const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Run echo LIVE_OK' },
];

const ids = {
  cascadeId: 'd5e8a6d1-74dd-4a05-95d2-4c412d43c949',
  executionId: 'f9dbf1e6-97ce-4bec-93e9-0a51305150c5',
  trajectoryId: '18a7c030-c818-455b-8ad8-afd00b17a357',
  messageIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
};

test('buildGetChatMessageRequest produces a connect-framed buffer with the proven top-level shape', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$test',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  assert.ok(Buffer.isBuffer(framed));
  const proto = stripConnect(framed);
  const top = parseFields(proto);

  // request_type #7 = CASCADE (5)
  const rt = getField(top, 7, 0);
  assert.ok(rt, 'request_type #7 present');
  assert.equal(rt.value, REQUEST_TYPE_CASCADE);
  assert.equal(REQUEST_TYPE_CASCADE, 5);

  // planner_mode #20 = 1
  assert.equal(getField(top, 20, 0).value, 1);

  // chat_model_uid #21
  assert.equal(getField(top, 21, 2).value.toString('utf8'), 'glm-5-2');

  // cascade_id #16, execution_id #22
  assert.equal(getField(top, 16, 2).value.toString('utf8'), ids.cascadeId);
  assert.equal(getField(top, 22, 2).value.toString('utf8'), ids.executionId);

  // metadata #1 present
  assert.ok(getField(top, 1, 2), 'metadata #1 present');
  // context blob #2 present
  assert.ok(getField(top, 2, 2), 'context blob #2 present');

  // No JWT fields 25/26, no chat_model_name #14
  assert.equal(getField(top, 25), null, 'no #25');
  assert.equal(getField(top, 26), null, 'no #26');
  assert.equal(getField(top, 14), null, 'no #14 chat_model_name (proven request omits it)');
});

test('metadata is chisel-shaped with the #31 extension blob and auth token at #3', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  const top = parseFields(stripConnect(framed));
  const meta = parseFields(getField(top, 1, 2).value);
  assert.equal(getField(meta, 1, 2).value.toString('utf8'), 'chisel', 'ide_name=chisel');
  assert.equal(getField(meta, 12, 2).value.toString('utf8'), 'chisel', 'extension_name=chisel');
  assert.equal(getField(meta, 3, 2).value.toString('utf8'), 'devin-session-token$abc', 'auth token at #3');
  const ext = getField(meta, 31, 2);
  assert.ok(ext, '#31 extension blob present');
  assert.equal(ext.value.length, 732, '#31 blob is the 732-byte template');
  // chisel shape: NO #8/#9/#10
  assert.equal(getField(meta, 8), null, 'no #8 hardware');
  assert.equal(getField(meta, 9), null, 'no #9 request_id');
  assert.equal(getField(meta, 10), null, 'no #10 session_id');
});

test('chat_message_prompts map OpenAI roles to the confirmed ChatMessagePrompt fields', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  const top = parseFields(stripConnect(framed));
  const prompts = getAllFields(top, 3);
  assert.equal(prompts.length, 2, 'one prompt per message');

  const p0 = parseFields(prompts[0].value);
  assert.equal(getField(p0, 1, 2).value.toString('utf8'), ids.messageIds[0]);
  assert.equal(getField(p0, 2, 0).value, SOURCE.SYSTEM);
  assert.equal(getField(p0, 3, 2).value.toString('utf8'), 'You are a helpful assistant.');

  const p1 = parseFields(prompts[1].value);
  assert.equal(getField(p1, 2, 0).value, SOURCE.USER);
  assert.equal(getField(p1, 3, 2).value.toString('utf8'), 'Run echo LIVE_OK');
});

test('tools map to ChatToolDefinition with ONLY #1 name, #2 description, #3 parameters(JSON string)', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  const top = parseFields(stripConnect(framed));
  const defs = getAllFields(top, 10);
  assert.equal(defs.length, 1);
  const d0 = parseFields(defs[0].value);
  // signature must be exactly #1:2,#2:2,#3:2
  assert.deepEqual(
    d0.map((f) => `#${f.field}:${f.wireType}`),
    ['#1:2', '#2:2', '#3:2'],
  );
  assert.equal(getField(d0, 1, 2).value.toString('utf8'), 'exec');
  assert.equal(getField(d0, 2, 2).value.toString('utf8'), 'Run a shell command and return its output.');
  const paramStr = getField(d0, 3, 2).value.toString('utf8');
  const parsed = JSON.parse(paramStr);
  assert.equal(parsed.type, 'object');
  assert.deepEqual(parsed.required, ['command']);
});

test('CompletionConfiguration #8 carries the observed ground-truth fields', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  const top = parseFields(stripConnect(framed));
  const cfg = parseFields(getField(top, 8, 2).value);
  assert.equal(getField(cfg, 1, 0).value, 1);
  assert.equal(getField(cfg, 2, 0).value, 128000);
  assert.equal(getField(cfg, 3, 0).value, 400);
  assert.equal(getField(cfg, 5, 1).value.readDoubleLE(0), 1.0);
  assert.equal(getField(cfg, 7, 0).value, 40);
  assert.ok(Math.abs(getField(cfg, 8, 1).value.readDoubleLE(0) - 0.95) < 1e-6);
});

test('trajectory_reference #15 uses observed #1 uuid, #3=4, #4=14', () => {
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages,
    tools,
    model: { uid: 'glm-5-2' },
    ids,
  });
  const top = parseFields(stripConnect(framed));
  const tr = parseFields(getField(top, 15, 2).value);
  assert.equal(getField(tr, 1, 2).value.toString('utf8'), ids.trajectoryId);
  assert.equal(getField(tr, 3, 0).value, 4);
  assert.equal(getField(tr, 4, 0).value, 14);
});

test('assistant tool_calls and tool results round-trip into ChatMessagePrompt', () => {
  const convo = [
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
  ];
  const framed = buildGetChatMessageRequest({
    apiKey: 'devin-session-token$abc',
    messages: convo,
    tools,
    model: { uid: 'glm-5-2' },
    ids: { ...ids, messageIds: ['a', 'b', 'c'] },
  });
  const top = parseFields(stripConnect(framed));
  const prompts = getAllFields(top, 3);
  assert.equal(prompts.length, 3);

  // assistant prompt: source=2 (ASSISTANT), tool_calls at #6
  const asst = parseFields(prompts[1].value);
  assert.equal(getField(asst, 2, 0).value, SOURCE.ASSISTANT);
  const tc = parseFields(getField(asst, 6, 2).value);
  assert.equal(getField(tc, 1, 2).value.toString('utf8'), 'call_1');
  assert.equal(getField(tc, 2, 2).value.toString('utf8'), 'exec');
  assert.equal(getField(tc, 3, 2).value.toString('utf8'), '{"command":"ls"}');

  // tool prompt: source=4, tool_call_id at #7, result text at #3
  const toolP = parseFields(prompts[2].value);
  assert.equal(getField(toolP, 2, 0).value, SOURCE.TOOL);
  assert.equal(getField(toolP, 7, 2).value.toString('utf8'), 'call_1');
  assert.equal(getField(toolP, 3, 2).value.toString('utf8'), 'file.txt');
});

test('the captured request fixture decodes to the same top-level shape this encoder emits', () => {
  const fixture = readFileSync(join(FIX, 'glm52-tool-request.connectproto.bin'));
  const top = parseFields(stripConnect(fixture));
  const counts = {};
  for (const f of top) counts[f.field] = (counts[f.field] || 0) + 1;
  // The proven request shape: #1,#2,#3*,#7,#8,#10*,#15,#16,#20,#21,#22
  assert.equal(counts[1], 1);
  assert.equal(counts[2], 1);
  assert.ok(counts[3] >= 1);
  assert.equal(counts[7], 1);
  assert.equal(counts[8], 1);
  assert.ok(counts[10] >= 1);
  assert.equal(counts[15], 1);
  assert.equal(counts[16], 1);
  assert.equal(counts[20], 1);
  assert.equal(counts[21], 1);
  assert.equal(counts[22], 1);
  assert.equal(counts[14], undefined, 'fixture omits #14 chat_model_name');
  assert.equal(counts[25], undefined);
  assert.equal(counts[26], undefined);
});

// ─── Regression: ChatMessageSource LITERAL values (must match affogato) ───
// Pins the enum to empirically-confirmed wire values so it can't silently
// regress to the legacy windsurf.js labels (SYSTEM=2/ASSISTANT=3), which make
// the GLM provider reject multi-turn requests. Verified vs captured flow 008.
test('multi-turn source values match real affogato capture (assistant=2, tool=4, no #3 on tool-call turn)', () => {
  const msgs = [
    { role: 'user', content: 'echo HELLO' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"echo HELLO"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'HELLO' },
  ];
  const body = buildGetChatMessageRequest({ apiKey: 'devin-x', messages: msgs, tools: [{ type: 'function', function: { name: 'run_shell', parameters: { type: 'object', properties: {} } } }], model: 'glm-5-2' });
  const top = parseFields(stripConnect(Buffer.from(body)));
  const prompts = top.filter(f => f.field === 3 && f.wireType === 2).map(f => parseFields(f.value));
  const srcOf = p => p.find(x => x.field === 2)?.value;
  const has = (p, n) => p.some(x => x.field === n);

  assert.equal(srcOf(prompts[0]), 1, 'user => source 1');
  assert.equal(srcOf(prompts[1]), 2, 'assistant => source 2 (NOT legacy 3)');
  assert.equal(has(prompts[1], 6), true, 'assistant carries tool_calls #6');
  assert.equal(has(prompts[1], 3), false, 'assistant tool-call turn omits #3 (matches affogato)');
  assert.equal(srcOf(prompts[2]), 4, 'tool => source 4');
  assert.equal(has(prompts[2], 7), true, 'tool carries tool_call_id #7');
});
