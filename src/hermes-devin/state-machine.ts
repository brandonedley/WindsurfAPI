// @ts-nocheck
export const COMPAT_STATES = Object.freeze({
  received: 'received',
  budget_checked: 'budget_checked',
  tools_classified: 'tools_classified',
  dispatching: 'dispatching',
  streaming: 'streaming',
  tool_call_emitted: 'tool_call_emitted',
  awaiting_tool_result: 'awaiting_tool_result',
  post_tool_continuation: 'post_tool_continuation',
  completed: 'completed',
  client_aborted: 'client_aborted',
  rate_limited: 'rate_limited',
  failed_nonretryable: 'failed_nonretryable',
});

const TERMINAL_STATES = new Set([
  COMPAT_STATES.completed,
  COMPAT_STATES.client_aborted,
  COMPAT_STATES.rate_limited,
  COMPAT_STATES.failed_nonretryable,
]);

function nowIso() {
  return new Date().toISOString();
}

export function createCompatTrace(requestId, input = {}) {
  const trace = {
    requestId,
    modelKey: input.modelKey || '',
    toolCount: Number(input.toolCount || 0),
    createdAt: nowIso(),
    events: [],
  };
  transition(trace, COMPAT_STATES.received, {
    modelKey: trace.modelKey,
    toolCount: trace.toolCount,
  });
  return trace;
}

export function transition(trace, nextState, meta = {}) {
  if (!trace || !Array.isArray(trace.events)) throw new Error('invalid compat trace');
  const current = trace.events.at(-1)?.state;
  if (current && TERMINAL_STATES.has(current)) {
    throw new Error(`cannot transition from terminal state ${current} to ${nextState}`);
  }
  if (!Object.prototype.hasOwnProperty.call(COMPAT_STATES, nextState)) {
    throw new Error(`unknown compat state: ${nextState}`);
  }
  const event = {
    state: nextState,
    at: nowIso(),
    meta: meta || {},
  };
  trace.events.push(event);
  return event;
}

export function summarizeTrace(trace) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const terminalState = events.at(-1)?.state || 'unknown';
  const budget = events.find(e => e.state === COMPAT_STATES.budget_checked)?.meta || {};
  const tools = events.find(e => e.state === COMPAT_STATES.tools_classified)?.meta || {};
  return {
    requestId: trace?.requestId || '',
    modelKey: trace?.modelKey || '',
    terminalState,
    budgetAction: budget.action || null,
    toolCounts: {
      native: Number(tools.native || 0),
      emulated: Number(tools.emulated || 0),
      denied: Number(tools.denied || 0),
    },
    events: events.map(e => e.state),
  };
}
