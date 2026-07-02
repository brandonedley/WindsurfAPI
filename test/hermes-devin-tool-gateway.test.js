import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildHermesDevinToolGateway } from '../src/hermes-devin/tool-gateway.js';
import { TOOL_MODE } from '../src/hermes-devin/tool-policy.js';

const HERMES_32 = [
  'browser_back', 'browser_click', 'browser_console', 'browser_get_images',
  'browser_navigate', 'browser_press', 'browser_scroll', 'browser_snapshot',
  'browser_type', 'browser_vision', 'clarify', 'cronjob', 'delegate_task',
  'execute_code', 'image_generate', 'memory', 'patch', 'process', 'read_file',
  'search_files', 'send_message', 'session_search', 'skill_manage', 'skill_view',
  'skills_list', 'terminal', 'text_to_speech', 'todo', 'vision_analyze',
  'web_extract', 'web_search', 'write_file',
];

function tool(name, properties = { input: { type: 'string' } }, required = Object.keys(properties)) {
  return { type: 'function', function: { name, description: `${name} tool`, parameters: { type: 'object', properties, required } } };
}

describe('Hermes Devin all-tool gateway', () => {
  it('keeps every declared Hermes tool available to the Hermes loop', () => {
    const gateway = buildHermesDevinToolGateway(HERMES_32.map(name => tool(name)));
    assert.equal(gateway.effectiveTools.length, 32);
    assert.equal(gateway.denied.length, 0);
    assert.equal(gateway.summary.declared, 32);
    assert.equal(gateway.summary.emulated, 32);
  });

  it('denies heuristic recovery without denying declared stateful tool calls', () => {
    const gateway = buildHermesDevinToolGateway([
      tool('memory', { action: { type: 'string' }, target: { type: 'string' }, content: { type: 'string' } }, ['action', 'target']),
      tool('patch', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
      tool('terminal', { command: { type: 'string' } }, ['command']),
      tool('read_file', { path: { type: 'string' } }, ['path']),
    ]);

    const byName = Object.fromEntries(gateway.classified.map(t => [t.name, t]));
    assert.equal(byName.memory.mode, TOOL_MODE.emulated);
    assert.equal(byName.memory.recovery.narrativeIntent, false);
    assert.equal(byName.patch.mode, TOOL_MODE.emulated);
    assert.equal(byName.patch.recovery.narrativeIntent, false);
    assert.equal(byName.terminal.recovery.command, false);
    assert.equal(byName.terminal.heuristicRecoveryAllowed, false);
    assert.equal(byName.read_file.recovery.filePath, false);
    assert.equal(byName.read_file.heuristicRecoveryAllowed, false);
  });

  it('marks native-capable tools when the native bridge has already mapped them', () => {
    const gateway = buildHermesDevinToolGateway([
      tool('terminal', { command: { type: 'string' } }, ['command']),
      tool('read_file', { path: { type: 'string' } }, ['path']),
      tool('memory', { action: { type: 'string' } }, ['action']),
    ], { nativeToolNames: ['terminal', 'read_file'] });

    assert.deepEqual(gateway.native.map(t => t.name), ['terminal', 'read_file']);
    assert.deepEqual(gateway.emulated.map(t => t.name), ['memory']);
    assert.equal(gateway.effectiveTools.length, 3);
  });
});
