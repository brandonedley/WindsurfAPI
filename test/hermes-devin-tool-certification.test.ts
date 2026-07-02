import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildHermesDevinToolGateway } from '../src/hermes-devin/tool-gateway.js';

const HERMES_TOOLS = [
  'browser_back', 'browser_click', 'browser_console', 'browser_get_images',
  'browser_navigate', 'browser_press', 'browser_scroll', 'browser_snapshot',
  'browser_type', 'browser_vision', 'clarify', 'cronjob', 'delegate_task',
  'execute_code', 'image_generate', 'memory', 'patch', 'process', 'read_file',
  'search_files', 'send_message', 'session_search', 'skill_manage', 'skill_view',
  'skills_list', 'terminal', 'text_to_speech', 'todo', 'vision_analyze',
  'web_extract', 'web_search', 'write_file',
];

function tool(name: string) {
  const properties = name === 'terminal'
    ? { command: { type: 'string' } }
    : name === 'read_file'
      ? { path: { type: 'string' } }
      : name === 'search_files'
        ? { pattern: { type: 'string' }, path: { type: 'string' } }
        : { input: { type: 'string' } };
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties, required: Object.keys(properties) },
    },
  };
}

describe('Hermes Devin tool certification', () => {
  it('certifies all Hermes tools with deterministic execution owners and no dropped tools', () => {
    const gateway = buildHermesDevinToolGateway(HERMES_TOOLS.map(tool), {
      nativeToolNames: ['terminal', 'read_file'],
    });

    assert.equal(gateway.certification.total, HERMES_TOOLS.length);
    assert.deepEqual(gateway.certification.dropped, []);
    assert.deepEqual(gateway.certification.unknown, []);
    assert.equal(gateway.certification.byOwner.cascade_native_bridge, 2);
    assert.equal(gateway.certification.byOwner.hermes_tool_executor, 30);

    const byName = Object.fromEntries(gateway.classified.map((t: any) => [t.name, t]));
    assert.equal(byName.terminal.executionOwner, 'cascade_native_bridge');
    assert.equal(byName.read_file.executionOwner, 'cascade_native_bridge');
    assert.equal(byName.memory.executionOwner, 'hermes_tool_executor');
    assert.equal(byName.patch.heuristicRecoveryAllowed, false);
    assert.equal(byName.send_message.heuristicRecoveryAllowed, false);
    assert.equal(byName.web_search.executionOwner, 'hermes_tool_executor');
  });
});
