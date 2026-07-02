import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_MODE,
  classifyHermesTool,
  classifyToolInventory,
  isRecoveryAllowed,
} from '../src/hermes-devin/tool-policy.js';

function fnTool(name, props = { input: 'string' }, required = Object.keys(props)) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(props).map(([key, type]) => [key, { type }]),
        ),
        required,
      },
    },
  };
}

describe('Hermes Devin tool policy — strict no-prose-recovery boundary', () => {
  it('refuses heuristic recovery for every tool kind, including terminal and read_file', () => {
    for (const [name, param] of [
      ['terminal', 'command'],
      ['shell_command', 'command'],
      ['read_file', 'path'],
      ['memory', 'input'],
      ['patch', 'path'],
      ['write_file', 'path'],
    ]) {
      assert.equal(isRecoveryAllowed(name, param, 'command'), false, `${name} command recovery`);
      assert.equal(isRecoveryAllowed(name, param, 'filePath'), false, `${name} filePath recovery`);
      assert.equal(isRecoveryAllowed(name, param, 'genericArgument'), false, `${name} generic recovery`);
      assert.equal(isRecoveryAllowed(name, param, 'narrativeIntent'), false, `${name} narrative recovery`);
    }
  });
});

describe('Hermes Devin tool policy — declared structured tools stay available', () => {
  it('classifies terminal as declared emulated without heuristic recovery', () => {
    const classified = classifyHermesTool(fnTool('terminal', { command: 'string' }, ['command']));
    assert.equal(classified.name, 'terminal');
    assert.equal(classified.mode, TOOL_MODE.emulated);
    assert.equal(classified.reason, 'declared_tool_structured_only');
    assert.equal(classified.recovery.command, false);
    assert.equal(classified.recovery.filePath, false);
    assert.equal(classified.recovery.narrativeIntent, false);
  });

  it('classifies read_file as declared emulated without heuristic recovery', () => {
    const classified = classifyHermesTool(fnTool('read_file', { path: 'string' }, ['path']));
    assert.equal(classified.name, 'read_file');
    assert.equal(classified.mode, TOOL_MODE.emulated);
    assert.equal(classified.reason, 'declared_tool_structured_only');
    assert.equal(classified.recovery.command, false);
    assert.equal(classified.recovery.filePath, false);
    assert.equal(classified.recovery.narrativeIntent, false);
  });

  it('keeps stateful tools declared but not recoverable from prose', () => {
    const classified = classifyHermesTool(fnTool('memory', { action: 'string', target: 'string', content: 'string' }, ['action', 'target']));
    assert.equal(classified.name, 'memory');
    assert.equal(classified.mode, TOOL_MODE.emulated);
    assert.equal(classified.reason, 'declared_tool_structured_only');
    assert.equal(classified.recovery.command, false);
    assert.equal(classified.recovery.filePath, false);
    assert.equal(classified.recovery.narrativeIntent, false);
  });

  it('partitions a mixed Hermes inventory without granting recovery privileges', () => {
    const result = classifyToolInventory([
      fnTool('terminal', { command: 'string' }, ['command']),
      fnTool('read_file', { path: 'string' }, ['path']),
      fnTool('memory', { action: 'string', target: 'string' }, ['action', 'target']),
    ]);

    assert.deepEqual(result.emulated.map(t => t.name), ['terminal', 'read_file', 'memory']);
    assert.deepEqual(result.denied.map(t => t.name), []);
    assert.equal(result.summary.emulated, 3);
    assert.equal(result.summary.denied, 0);
    assert.equal(result.summary.recoveryAllowed, 0);
    assert.equal(result.all.every(t => t.heuristicRecoveryAllowed === false), true);
  });
});
