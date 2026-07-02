import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCompatTrace, summarizeTrace, transition } from '../src/hermes-devin/state-machine.js';

describe('Hermes Devin compatibility trace state machine', () => {
  it('records ordered lifecycle transitions with metadata', () => {
    const trace = createCompatTrace('req-1', { modelKey: 'glm-5.1', toolCount: 32 });
    transition(trace, 'budget_checked', { action: 'reject' });
    transition(trace, 'tools_classified', { native: 0, emulated: 32, denied: 0 });
    transition(trace, 'failed_nonretryable', { status: 413 });

    assert.deepEqual(trace.events.map((e: any) => e.state), [
      'received',
      'budget_checked',
      'tools_classified',
      'failed_nonretryable',
    ]);
    assert.equal(summarizeTrace(trace).terminalState, 'failed_nonretryable');
    assert.equal(summarizeTrace(trace).budgetAction, 'reject');
    assert.equal(summarizeTrace(trace).toolCounts.emulated, 32);
  });

  it('rejects transitions after terminal states', () => {
    const trace = createCompatTrace('req-2', { modelKey: 'kimi-k2-6' });
    transition(trace, 'completed');
    assert.throws(() => transition(trace, 'dispatching'), /terminal/);
  });
});
