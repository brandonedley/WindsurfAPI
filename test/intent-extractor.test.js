// v2.0.72 (#115 #120) — NLU intent extractor tests.
//
// Cover real captures from probe runs against GLM-4.7 / GLM-5.1 / GPT-5.5 /
// Kimi-K2 in cascade backend, plus synthetic patterns we expect future
// models to use. Layer 1 (explicit syntax) → Layer 3 (narrative) ordered
// by confidence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractIntentFromNarrative, detectToolIntentInNarrative } from '../src/handlers/intent-extractor.js';

const fnTool = (name, props = { command: 'string' }, required = ['command']) => ({
  type: 'function',
  function: {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
      required,
    },
  },
});

const SHELL_TOOL = fnTool('shell_exec');
const READ_TOOL = fnTool('Read', { file_path: 'string' }, ['file_path']);
const ACTIONABLE = { lastUserText: 'run shell_exec to echo something' };

describe('Layer 1 — explicit invocation syntax', () => {
  it('extracts shell_exec(command="echo HI")', () => {
    const r = extractIntentFromNarrative(
      'shell_exec(command="echo HI")',
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell_exec');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HI' });
    assert.equal(r[0].layer, 'explicit-syntax');
    assert.ok(r[0].confidence >= 0.9);
  });

  it('extracts function_call: name=shell_exec args={"command":"X"}', () => {
    const r = extractIntentFromNarrative(
      'function_call: name=shell_exec args={"command":"echo X"}',
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell_exec');
    assert.equal(JSON.parse(r[0].argumentsJson).command, 'echo X');
  });

  it('rejects fn name not in tools[]', () => {
    const r = extractIntentFromNarrative(
      'os_command(cmd="echo X")', [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 0);
  });
});

describe('Layer 2 — backtick-quoted name + value', () => {
  it("extracts I'll call `shell_exec` with command `echo HI`", () => {
    const r = extractIntentFromNarrative(
      "I'll call `shell_exec` with command `echo HI`",
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].layer, 'backtick-quoted');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HI' });
  });

  it('does not promote a backtick-quoted tool inventory into tool calls (#196)', () => {
    const tools = ['read', 'write', 'edit', 'grep', 'bash'].map(name => fnTool(name));
    const r = extractIntentFromNarrative(
      '我有以下这些工具：**文件操作** - `read` — 读取文件或目录 - `write` — 写入文件 - `edit` — 精确替换文件内容 - `grep` — 内容搜索 - `bash` — 执行命令',
      tools,
      { lastUserText: '你有啥工具' },
    );
    assert.equal(r.length, 0);
  });

  it('extracts use the `Read` function with file_path `/etc/hosts`', () => {
    const r = extractIntentFromNarrative(
      'use the `Read` function with file_path `/etc/hosts`',
      [READ_TOOL], { lastUserText: 'read the file at /etc/hosts' },
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Read');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { file_path: '/etc/hosts' });
  });
});

describe('Layer 3 — natural narrative (live GLM-4.7 reproducer)', () => {
  it("LIVE: 'I should call the shell_exec function with the command \"echo HELLO_FROM_PROBE\"'", () => {
    // This is the actual emit captured from glm-4.7 probe before v2.0.72.
    const r = extractIntentFromNarrative(
      'I should call the shell_exec function with the command "echo HELLO_FROM_PROBE".',
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell_exec');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO_FROM_PROBE' });
    assert.equal(r[0].layer, 'narrative');
  });

  it("'Let me run shell_exec with command echo HI'", () => {
    const r = extractIntentFromNarrative(
      "Let me run shell_exec with command 'echo HI'",
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell_exec');
  });

  it("'I'll invoke the Read tool to read /etc/hosts'", () => {
    const r = extractIntentFromNarrative(
      "I'll invoke the Read tool to read /etc/hosts",
      [READ_TOOL], { lastUserText: 'read /etc/hosts' },
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Read');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { file_path: '/etc/hosts' });
  });

  it('Layer 3 only fires when user prompt is actionable', () => {
    const r = extractIntentFromNarrative(
      'I should call the shell_exec function with the command "echo HI".',
      [SHELL_TOOL],
      { lastUserText: 'tell me about your day' }, // NOT actionable
    );
    assert.equal(r.length, 0);
  });

  // v2.0.76 follow-up — caught in v2.0.75 e2e probe against glm-4.7.
  // GLM emitted "...with command 'command'" (the literal word) which
  // made the regex bind value="command". Filter placeholder values.
  it("rejects placeholder values ('command' / 'argument' / 'input' / etc.)", () => {
    const r = extractIntentFromNarrative(
      "I'll call shell_exec with command 'command'.",
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 0);
  });

  it("dedupes when narrative says the real command then echoes 'with command command'", () => {
    // Real GLM-4.7 v2.0.75 probe pattern that produced 2 tool_calls,
    // one valid and one bogus. Now should produce just 1.
    const r = extractIntentFromNarrative(
      `I'll call shell_exec with command 'echo HELLO'. The user wants me to use the shell_exec function with command 'command' as the parameter name.`,
      [SHELL_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO' });
  });
});

describe('robustness', () => {
  it('returns [] for hopeless fabricated output (just a number)', () => {
    const r = extractIntentFromNarrative('1777751588', [SHELL_TOOL], ACTIONABLE);
    assert.equal(r.length, 0);
  });

  it('returns [] for empty / null input', () => {
    assert.deepEqual(extractIntentFromNarrative('', [SHELL_TOOL], ACTIONABLE), []);
    assert.deepEqual(extractIntentFromNarrative(null, [SHELL_TOOL], ACTIONABLE), []);
    assert.deepEqual(extractIntentFromNarrative('text', [], ACTIONABLE), []);
  });

  it('dedupes identical extractions', () => {
    const text = 'I should call the shell_exec function with the command "echo X". '
      + 'shell_exec(command="echo X")';
    const r = extractIntentFromNarrative(text, [SHELL_TOOL], ACTIONABLE);
    // Same (name, args) → 1 entry. Layer 1 wins on confidence.
    assert.equal(r.length, 1);
    assert.equal(r[0].layer, 'explicit-syntax');
  });

  it('keeps multiple distinct tool_calls', () => {
    const text = 'shell_exec(command="ls")\nshell_exec(command="pwd")';
    const r = extractIntentFromNarrative(text, [SHELL_TOOL], ACTIONABLE);
    assert.equal(r.length, 2);
    const cmds = r.map(x => JSON.parse(x.argumentsJson).command).sort();
    assert.deepEqual(cmds, ['ls', 'pwd']);
  });

  it('env WINDSURFAPI_NLU_RECOVERY=0 disables extractor entirely', () => {
    const orig = process.env.WINDSURFAPI_NLU_RECOVERY;
    process.env.WINDSURFAPI_NLU_RECOVERY = '0';
    try {
      const r = extractIntentFromNarrative(
        'shell_exec(command="echo HI")', [SHELL_TOOL], ACTIONABLE,
      );
      assert.equal(r.length, 0);
    } finally {
      if (orig !== undefined) process.env.WINDSURFAPI_NLU_RECOVERY = orig;
      else delete process.env.WINDSURFAPI_NLU_RECOVERY;
    }
  });
});

describe('confidence threshold opt', () => {
  it('opt.minConfidence filters layer 3 narrative-only extractions', () => {
    // Default threshold lets narrative through (0.65). Bump to 0.8
    // and only Layer 1+2 survive.
    const text = 'I should call the shell_exec function with the command "echo HI".';
    const high = extractIntentFromNarrative(text, [SHELL_TOOL], { ...ACTIONABLE, minConfidence: 0.8 });
    assert.equal(high.length, 0);
    const low = extractIntentFromNarrative(text, [SHELL_TOOL], { ...ACTIONABLE, minConfidence: 0.5 });
    assert.equal(low.length, 1);
  });
});

// v2.0.83 (audit NLU-1): the per-tool-name regex layers (Layer 2/3 and
// detectToolIntentInNarrative Pass 1) each scan the full text once PER
// declared tool. With an unbounded tools[] this is O(N_tools × textLen) —
// tens of thousands of tools × long text ≈ 10⁹–10¹⁰ synchronous regex ops
// that freeze the single-process event loop. indexTools now caps the scan
// at 64 distinct tool names so cost is bounded regardless of how many tools
// a request declares.
describe('NLU-1 — tool-count DoS bound', () => {
  // Small-scale linearity proof: even a pathological input (tens of
  // thousands of tools × a long narrative that name-matches every tool)
  // must return in well under a second. Pre-fix this drives a polynomial
  // blow-up; post-fix the scan is capped at MAX_NLU_TOOLS (64).
  const N_TOOLS = 40_000;
  const bigToolset = () => {
    const tools = new Array(N_TOOLS);
    for (let i = 0; i < N_TOOLS; i++) tools[i] = fnTool(`tool_${i}`);
    return tools;
  };
  // ~200K of narrative that mentions many tool names + arg keywords, i.e.
  // the exact shape that makes every per-tool regex do maximal work.
  const bigText = ('Let me call the tool_1 function with command "echo X". '
    + 'I should use `tool_2` with command `echo Y`. ').repeat(2600).slice(0, 200_000);

  it('extractIntentFromNarrative returns quickly for 40K tools × long text', () => {
    const tools = bigToolset();
    const start = Date.now();
    const r = extractIntentFromNarrative(bigText, tools, ACTIONABLE);
    const elapsed = Date.now() - start;
    assert.ok(Array.isArray(r), 'returns an array');
    assert.ok(elapsed < 1000, `expected < 1000ms, took ${elapsed}ms (polynomial blow-up not bounded)`);
  });

  it('detectToolIntentInNarrative returns quickly for 40K tools × long text', () => {
    const tools = bigToolset();
    const start = Date.now();
    const r = detectToolIntentInNarrative(bigText, tools, ACTIONABLE);
    const elapsed = Date.now() - start;
    assert.ok(r === null || typeof r === 'string');
    assert.ok(elapsed < 1000, `expected < 1000ms, took ${elapsed}ms (polynomial blow-up not bounded)`);
  });

  it('scan is bounded to the first 64 declared tools', () => {
    // A tool that only appears AFTER the 64-name cap must not be matched,
    // even though its name is present in the narrative. This proves the
    // scan operates on a bounded prefix of tools[] rather than all of them.
    // Zero-pad names so none is a substring/prefix of another (the Layer 3
    // name pattern is not end-anchored, so `tool_1` would otherwise match
    // inside `tool_150`).
    const pad = n => `tool_${String(n).padStart(3, '0')}`;
    const tools = [];
    for (let i = 0; i < 200; i++) tools.push(fnTool(pad(i), { command: 'string' }, ['command']));
    const beyondCap = pad(150);
    const r = extractIntentFromNarrative(
      `I'll call ${beyondCap}(command="echo HI")`,
      tools, ACTIONABLE,
    );
    assert.equal(r.length, 0, 'a tool beyond the 64-name cap is not scanned');
    // ...but a tool within the cap still works.
    const r2 = extractIntentFromNarrative(
      `I'll call ${pad(0)}(command="echo HI")`,
      tools, ACTIONABLE,
    );
    assert.equal(r2.length, 1);
    assert.equal(r2[0].name, pad(0));
  });

  it('normal small toolsets are unaffected by the cap', () => {
    const r = extractIntentFromNarrative(
      'shell_exec(command="echo HI")',
      [SHELL_TOOL, READ_TOOL], ACTIONABLE,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell_exec');
  });
});
