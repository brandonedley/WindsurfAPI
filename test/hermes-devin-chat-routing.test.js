import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildToolRoutingPlan, summarizeToolRoutingDiagnostics } from '../src/handlers/chat.js';

function tool(name) {
  return { type: 'function', function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } };
}

describe('chat tool routing exposes Hermes-Devin gateway diagnostics', () => {
  it('does not deny declared Hermes stateful tools when native bridge is off', () => {
    const tools = ['memory', 'patch', 'send_message', 'terminal', 'read_file'].map(tool);
    const plan = buildToolRoutingPlan(tools, { useCascade: true, modelKey: 'glm-5.2', provider: 'zhipu' });
    assert.equal(plan.hermesDevinGateway.summary.declared, 5);
    assert.equal(plan.hermesDevinGateway.summary.denied, 0);
    assert.equal(plan.hermesDevinGateway.summary.emulated, 5);
    assert.equal(plan.emulationTools.length, 5);

    const diag = summarizeToolRoutingDiagnostics({ tools, effectiveTools: tools, toolChoice: 'auto', toolRouting: plan });
    assert.equal(diag.gateway.denied, 0);
    assert.equal(diag.gateway.emulated, 5);
  });
});
