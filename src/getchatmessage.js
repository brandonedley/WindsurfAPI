/**
 * S-tier GetChatMessage transport — native tool-calling against the Codeium
 * cloud ApiServerService.
 *
 * This module is PURE: it only builds connect-framed request bytes and parses
 * connect-streaming response bytes. Network I/O lives in src/client.js.
 *
 * Ground truth comes from real captured fixtures under
 * test/fixtures/getchatmessage/ (see the transport spec in the project memory).
 * The protobuf shapes below were confirmed by decoding those fixtures field by
 * field — do NOT re-derive them.
 *
 * ENDPOINT: POST {apiServerUrl}/exa.api_server_pb.ApiServerService/GetChatMessage
 * BODY framing: connect unary  = [0x00][uint32 BE len][protobuf]
 * RESP framing: connect stream = repeated [1 flag][uint32 BE len][payload];
 *               a frame with (flag & 0x02) != 0 is the JSON trailer.
 */

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  writeVarintField,
  writeStringField,
  writeMessageField,
  writeBytesField,
  writeFixed64Field,
  parseFields,
  getField,
  getAllFields,
} from './proto.js';

// ─── Enums (CONFIRMED) ─────────────────────────────────────

// ChatMessageSource — values CONFIRMED from captured affogato continuation
// traffic (flow 008): the prior assistant tool-call turn is encoded source=2,
// the tool result source=4, and system context (rules/skills) is folded into
// USER=1 turns. The legacy src/windsurf.js labels (SYSTEM=2, ASSISTANT=3) are
// for a different/older message type and do NOT apply here — using ASSISTANT=3
// makes the GLM provider reject multi-turn requests as malformed.
export const SOURCE = {
  USER: 1,
  ASSISTANT: 2,
  TOOL: 4,
  // No distinct SYSTEM source in this protocol; fold system into USER.
  SYSTEM: 1,
};

export const REQUEST_TYPE_CASCADE = 5;
export const PLANNER_MODE = 1;

// Authoritative `exa.codeium_common_pb.StopReason` enum, extracted from the
// language-server FileDescriptorProto and cross-checked against live captures:
// a tool turn ends with FUNCTION_CALL=10 (capture/replay_ok.bin), a normal text
// turn with STOP_PATTERN=2 (live devin glm-5-2 capture). This is the field-5
// (`stop_reason`) value the response parser reads at getchatmessage.js:392.
export const STOP_REASON = {
  UNSPECIFIED: 0,
  INCOMPLETE: 1,
  STOP_PATTERN: 2,
  MAX_TOKENS: 3,
  MIN_LOG_PROB: 4,
  MAX_NEWLINES: 5,
  EXIT_SCOPE: 6,
  NONFINITE_LOGIT_OR_PROB: 7,
  FIRST_NON_WHITESPACE_LINE: 8,
  PARTIAL: 9,
  FUNCTION_CALL: 10,
  CONTENT_FILTER: 11,
  NON_INSERTION: 12,
  ERROR: 13,
};

// Back-compat alias: the tool-use sentinel callers already key off.
export const STOP_REASON_TOOL_USE = STOP_REASON.FUNCTION_CALL;

/**
 * Map a GetChatMessage `stop_reason` to an OpenAI `finish_reason` for a
 * NON-tool turn. Tool-call turns are decided by the caller (driven by the
 * presence of parsed tool_calls), so FUNCTION_CALL is intentionally not
 * special-cased here — when there are no tool_calls it falls through to 'stop'.
 *   MAX_TOKENS(3)      -> 'length'          (genuine truncation)
 *   CONTENT_FILTER(11) -> 'content_filter'
 *   everything else    -> 'stop'
 */
export function stopReasonToFinishReason(stopReason) {
  switch (stopReason) {
    case STOP_REASON.MAX_TOKENS:
      return 'length';
    case STOP_REASON.CONTENT_FILTER:
      return 'content_filter';
    default:
      return 'stop';
  }
}

// ─── Template blobs (carried verbatim from the proven request) ──
//
// The working request used the "chisel" client shape whose Metadata carries a
// 732-byte opaque extension blob at sub-field #31, and a client-supplied
// system/context payload at top-level field #2. Both are opaque and REQUIRED.
// We template them from the in-repo fixtures so the encoder is byte-faithful
// without re-deriving anything. Loaded once at module init; callers may
// override either via the `templates` arg.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, '..', 'test', 'fixtures', 'getchatmessage');

function loadTemplateOrNull(name) {
  try {
    return readFileSync(join(FIX_DIR, name));
  } catch {
    return null;
  }
}

// 732-byte chisel extension blob (Metadata #31). REQUIRED in the working request.
const METADATA_EXT31 = loadTemplateOrNull('metadata-ext31.bin');
// 204-byte compact context blob (top-level #2) from the continuation fixture.
const CONTEXT_BLOB_SMALL = loadTemplateOrNull('context-blob-small.bin');

// ─── Metadata (chisel-shaped) ──────────────────────────────

const DEFAULT_CHISEL_VERSION = '2026.5.26-8';

/**
 * Build a chisel-shaped Metadata message matching the proven request:
 *   #1 ide_name='chisel'  #2 extension_version  #3 auth token
 *   #4 locale='en'        #5 os='linux'         #7 ide_version
 *   #12 extension_name='chisel'   #31 732b extension blob (verbatim)
 *
 * NOTE: the auth token goes at #3 verbatim. The captured request put the
 * literal string `devin-session-token$<JWT>` there; callers pass whatever the
 * cloud expects in that slot (typically that exact prefixed token).
 */
export function buildChiselMetadata(apiKey, options = {}) {
  const version = options.version || DEFAULT_CHISEL_VERSION;
  const os = options.os || 'linux';
  const locale = options.locale || 'en';
  const ext31 = options.ext31 !== undefined ? options.ext31 : METADATA_EXT31;

  const parts = [
    writeStringField(1, 'chisel'),
    writeStringField(2, version),
    writeStringField(3, apiKey),
    writeStringField(4, locale),
    writeStringField(5, os),
    writeStringField(7, version),
    writeStringField(12, 'chisel'),
  ];
  if (ext31 && ext31.length) parts.push(writeBytesField(31, ext31));
  return Buffer.concat(parts);
}

// ─── CompletionConfiguration #8 ────────────────────────────

function doubleLE(val) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(val);
  return buf;
}

/**
 * CompletionConfiguration message. Field numbers are the OBSERVED ground-truth
 * numbers from the fixture (#1=1, #2 max_tokens, #3=400, #5 temperature double,
 * #7 top_k, #8 top_p double).
 */
export function buildCompletionConfiguration(cfg = {}) {
  const maxTokens = cfg.maxTokens ?? 128000;
  const field3 = cfg.field3 ?? 400;
  const temperature = cfg.temperature ?? 1.0;
  const topK = cfg.topK ?? 40;
  const topP = cfg.topP ?? 0.95;
  return Buffer.concat([
    writeVarintField(1, 1),
    writeVarintField(2, maxTokens),
    writeVarintField(3, field3),
    writeFixed64Field(5, doubleLE(temperature)),
    writeVarintField(7, topK),
    writeFixed64Field(8, doubleLE(topP)),
  ]);
}

// ─── ChatToolCall (used inside ASSISTANT prompts) ──────────

function buildChatToolCall(tc) {
  const id = tc.id || '';
  const name = tc.function?.name || tc.name || '';
  const args = tc.function?.arguments ?? tc.arguments ?? '';
  return Buffer.concat([
    writeStringField(1, id),
    writeStringField(2, name),
    writeStringField(3, typeof args === 'string' ? args : JSON.stringify(args)),
  ]);
}

// ─── ChatMessagePrompt #3 ──────────────────────────────────

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function roleToSource(role) {
  switch (role) {
    case 'system':
      return SOURCE.SYSTEM;
    case 'assistant':
      return SOURCE.ASSISTANT;
    case 'tool':
      return SOURCE.TOOL;
    case 'user':
    default:
      return SOURCE.USER;
  }
}

/**
 * Build one ChatMessagePrompt from an OpenAI message.
 *   #1 message_id (uuid)  #2 source (enum)  #3 prompt (text)
 *   #6 tool_calls (repeated, ASSISTANT only)
 *   #7 tool_call_id (TOOL only)  #9 tool_result_is_error (TOOL only)
 */
export function buildChatMessagePrompt(msg, messageId) {
  const source = roleToSource(msg.role);
  const text = contentToText(msg.content);
  const parts = [writeStringField(1, messageId), writeVarintField(2, source)];

  // Emit #3 prompt only when there's actual text. Captured affogato traffic
  // (flow 008 prompt#5) omits #3 entirely on an assistant turn that carried
  // only tool_calls — an empty #3 there is not what the real client sends.
  if (text) parts.push(writeStringField(3, text));

  if (source === SOURCE.ASSISTANT && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push(writeMessageField(6, buildChatToolCall(tc)));
    }
  }
  if (source === SOURCE.TOOL) {
    if (msg.tool_call_id) parts.push(writeStringField(7, msg.tool_call_id));
    if (msg.tool_result_is_error || msg.isError) parts.push(writeVarintField(9, 1));
  }
  return Buffer.concat(parts);
}

// writeStringField returns an empty buffer for '' (so the field would be
// dropped). The prompt #3 field must always be present even when empty, so
// encode a length-delimited field unconditionally.
function writeStringFieldAllowEmpty(field, str) {
  const data = Buffer.from(str ?? '', 'utf-8');
  const prefix = [];
  // Varint-encode the tag (field << 3 | wireType). A raw byte only works for
  // field < 16; for field >= 16 the tag exceeds 0x7f and needs continuation bytes.
  let tag = (field << 3) | 2;
  do {
    let b = tag & 0x7f;
    tag = Math.floor(tag / 128);
    if (tag > 0) b |= 0x80;
    prefix.push(b);
  } while (tag > 0);
  // Varint-encode the length.
  let v = data.length;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v > 0) b |= 0x80;
    prefix.push(b);
  } while (v > 0);
  return Buffer.concat([Buffer.from(prefix), data]);
}

// ─── ChatToolDefinition #10 ────────────────────────────────

/**
 * Map an OpenAI tools[] entry to a ChatToolDefinition.
 *   #1 name  #2 description  #3 parameters (JSON-schema as a STRING)
 * Emit ONLY these three fields — the proven request carried nothing else.
 */
export function buildChatToolDefinition(tool) {
  const fn = tool.function || tool;
  const name = fn.name || '';
  const description = fn.description || '';
  const parameters = fn.parameters !== undefined ? fn.parameters : {};
  const paramStr = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
  return Buffer.concat([
    writeStringField(1, name),
    writeStringField(2, description),
    writeStringField(3, paramStr),
  ]);
}

// ─── trajectory_reference #15 ──────────────────────────────

function buildTrajectoryReference(uuid) {
  // Observed shape: #1 uuid (string), #3=4, #4=14.
  return Buffer.concat([
    writeStringField(1, uuid),
    writeVarintField(3, 4),
    writeVarintField(4, 14),
  ]);
}

// ─── Connect framing ───────────────────────────────────────

function connectFrame(payload, flag = 0x00) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// ─── Top-level request encoder ─────────────────────────────

/**
 * buildGetChatMessageRequest — connect-framed GetChatMessageRequest bytes.
 *
 * @param {object} opts
 * @param {string} opts.apiKey   value for Metadata #3 (the auth/api-key slot)
 * @param {Array}  opts.messages OpenAI-format messages
 * @param {Array}  [opts.tools]  OpenAI tools[]
 * @param {object|string} [opts.model] { uid } or a uid string e.g. 'glm-5-2'
 * @param {object} [opts.completionConfig]
 * @param {object} [opts.ids]    { cascadeId, executionId, trajectoryId, messageIds[] }
 * @param {object} [opts.templates] { metadata?: Buffer, contextBlob?: Buffer }
 * @returns {Buffer} connect unary frame
 */
export function buildGetChatMessageRequest(opts = {}) {
  const {
    apiKey = '',
    messages = [],
    tools = [],
    model,
    completionConfig,
    ids = {},
    templates = {},
    metadataOptions = {},
  } = opts;

  const modelUid = typeof model === 'string' ? model : model?.uid || '';

  const cascadeId = ids.cascadeId || randomUUID();
  const executionId = ids.executionId || randomUUID();
  const trajectoryId = ids.trajectoryId || randomUUID();
  const messageIds = Array.isArray(ids.messageIds) ? ids.messageIds : [];

  const parts = [];

  // #1 metadata (chisel-shaped)
  const metadata = templates.metadata || buildChiselMetadata(apiKey, metadataOptions);
  parts.push(writeMessageField(1, metadata));

  // #2 context blob (opaque client payload; template it)
  const contextBlob = templates.contextBlob !== undefined ? templates.contextBlob : CONTEXT_BLOB_SMALL;
  if (contextBlob && contextBlob.length) parts.push(writeBytesField(2, contextBlob));

  // #3 repeated ChatMessagePrompt
  messages.forEach((msg, i) => {
    const mid = messageIds[i] || randomUUID();
    parts.push(writeMessageField(3, buildChatMessagePrompt(msg, mid)));
  });

  // #7 request_type = CASCADE
  parts.push(writeVarintField(7, REQUEST_TYPE_CASCADE));

  // #8 CompletionConfiguration
  parts.push(writeMessageField(8, buildCompletionConfiguration(completionConfig)));

  // #10 repeated ChatToolDefinition
  for (const tool of tools) {
    parts.push(writeMessageField(10, buildChatToolDefinition(tool)));
  }

  // #15 trajectory_reference
  parts.push(writeMessageField(15, buildTrajectoryReference(trajectoryId)));

  // #16 cascade_id
  parts.push(writeStringField(16, cascadeId));

  // #20 planner_mode
  parts.push(writeVarintField(20, PLANNER_MODE));

  // #21 chat_model_uid
  if (modelUid) parts.push(writeStringField(21, modelUid));

  // #22 execution_id
  parts.push(writeStringField(22, executionId));

  return connectFrame(Buffer.concat(parts));
}

// ─── Response data/trailer frame writers (test helpers) ────

export function writeResponseDataFrame(payload) {
  return connectFrame(payload, 0x00);
}

export function writeResponseTrailerFrame(json) {
  const buf = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf-8');
  return connectFrame(buf, 0x02);
}

// ─── Response decoder ──────────────────────────────────────

function makeState() {
  return {
    text: '',
    // ordered list of tool calls; first delta with an id starts a new one
    toolCalls: [],
    _byId: new Map(),
    _current: null,
    stopReason: null,
    errorTrailer: null,
    usage: null,
  };
}

function applyDataFrame(state, payload) {
  let fields;
  try {
    fields = parseFields(payload);
  } catch {
    return;
  }
  for (const { field, wireType, value } of fields) {
    if (field === 3 && wireType === 2) {
      state.text += value.toString('utf8');
    } else if (field === 5 && wireType === 0) {
      state.stopReason = Number(value);
    } else if (field === 6 && wireType === 2) {
      applyToolCallDelta(state, value);
    }
    // ignore #1/#2/#7/#12/#17/#28 misc fields
  }
}

function applyToolCallDelta(state, buf) {
  let tc;
  try {
    tc = parseFields(buf);
  } catch {
    return;
  }
  const idField = getField(tc, 1, 2);
  const nameField = getField(tc, 2, 2);
  const argsField = getField(tc, 3, 2);
  const id = idField ? idField.value.toString('utf8') : null;
  const name = nameField ? nameField.value.toString('utf8') : null;
  const argsFrag = argsField ? argsField.value.toString('utf8') : null;

  // A delta that carries an id starts (or selects) a tool call.
  if (id) {
    let entry = state._byId.get(id);
    if (!entry) {
      entry = { id, name: name || '', argumentsJson: '' };
      state._byId.set(id, entry);
      state.toolCalls.push(entry);
    } else if (name) {
      entry.name = name;
    }
    state._current = entry;
    if (argsFrag != null) entry.argumentsJson += argsFrag;
    return;
  }

  // No id on this delta: it carries only an argument fragment (and possibly a
  // late name). Append to the current in-progress call.
  if (!state._current) {
    // Defensive: a name-first delta with no id — start an anonymous call.
    state._current = { id: '', name: name || '', argumentsJson: '' };
    state.toolCalls.push(state._current);
  }
  if (name && !state._current.name) state._current.name = name;
  if (argsFrag != null) state._current.argumentsJson += argsFrag;
}

function applyTrailer(state, payload) {
  const txt = payload.toString('utf8').trim();
  if (!txt || txt === '{}') return;
  try {
    const obj = JSON.parse(txt);
    if (obj && obj.error) state.errorTrailer = obj;
  } catch {
    // Non-JSON trailer — surface as a raw error string.
    state.errorTrailer = { error: { message: txt } };
  }
}

function finalize(state) {
  delete state._byId;
  delete state._current;
  return state;
}

/**
 * Consume connect-streaming response frames out of a growing buffer.
 * Returns the new offset (bytes consumed) and mutates `state`.
 */
function drainFrames(buf, offset, state) {
  let off = offset;
  while (off + 5 <= buf.length) {
    const flag = buf[off];
    const len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) break; // wait for more bytes
    const payload = buf.subarray(off + 5, off + 5 + len);
    off += 5 + len;
    if (flag & 0x02) {
      applyTrailer(state, payload);
    } else {
      applyDataFrame(state, payload);
    }
  }
  return off;
}

/**
 * parseGetChatMessageResponse — decode a full Buffer OR an async iterable of
 * Buffer/Uint8Array chunks into:
 *   { text, toolCalls:[{id,name,argumentsJson}], stopReason, usage, errorTrailer }
 *
 * Returns synchronously for a Buffer; returns a Promise for an async iterable.
 */
export function parseGetChatMessageResponse(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const state = makeState();
    drainFrames(buf, 0, state);
    return finalize(state);
  }
  if (input && typeof input[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const state = makeState();
      let buf = Buffer.alloc(0);
      let off = 0;
      for await (const chunk of input) {
        buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        off = drainFrames(buf, off, state);
        // compact consumed bytes to keep the buffer small
        if (off > 0) {
          buf = buf.subarray(off);
          off = 0;
        }
      }
      drainFrames(buf, off, state);
      return finalize(state);
    })();
  }
  throw new TypeError('parseGetChatMessageResponse expects a Buffer or async iterable of chunks');
}

/**
 * Map the parsed result into OpenAI-style tool_calls.
 */
export function toOpenAIToolCalls(parsed) {
  return parsed.toolCalls.map((tc, i) => ({
    id: tc.id || `call_${i}`,
    type: 'function',
    function: { name: tc.name, arguments: tc.argumentsJson || '{}' },
  }));
}
