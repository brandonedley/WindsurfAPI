import { buildOpenAIContextBudgetError, decideContextBudget, measureCompatRequest } from './context-budget.js';
import { getHermesDevinModelPolicy } from './model-policy.js';
import { buildHermesDevinToolGateway } from './tool-gateway.js';
import { createCompatTrace, summarizeTrace, transition } from './state-machine.js';
import { parseHermesDevinModelOutput } from './protocol.js';
import type { AdapterInput, AdapterPrepared } from './types.js';

function toolCount(tools: unknown): number {
  return Array.isArray(tools) ? tools.length : 0;
}

function diagnosticsFromTrace(requestId: string, model: string, provider: string | null, trace: Record<string, unknown>) {
  const events = Array.isArray((trace as { events?: unknown }).events)
    ? (trace as { events: Array<{ state: string; at?: number; data?: Record<string, unknown> }> }).events.map(event => ({
        state: event.state,
        at: typeof event.at === 'number' ? event.at : Date.now(),
        data: event.data,
      }))
    : [];
  return { requestId, model, provider, events, summary: summarizeTrace(trace) };
}

export function prepareHermesDevinRequest(input: AdapterInput = {
  requestId: Math.random().toString(36).slice(2, 8),
  messages: [],
  tools: [],
}): AdapterPrepared {
  const requestId = input.requestId || Math.random().toString(36).slice(2, 8);
  const modelKey = input.modelKey || input.model || '';
  const provider = input.provider || null;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const displayModel = input.displayModel || modelKey;

  const trace = createCompatTrace(requestId, { modelKey, toolCount: toolCount(tools) });
  const modelPolicy = getHermesDevinModelPolicy(modelKey, provider);
  const measurement = measureCompatRequest({ messages, tools, modelPolicy });
  const budget = decideContextBudget(measurement, modelPolicy);
  transition(trace, 'budget_checked', {
    action: budget.action,
    reason: budget.reason,
    totalApproxChars: measurement.totalApproxChars,
    toolCount: measurement.toolCount,
  });

  const gateway = buildHermesDevinToolGateway(tools, {
    modelPolicy,
    nativeToolNames: input.nativeToolNames || [],
  });
  transition(trace, 'tools_classified', {
    native: gateway.summary.native,
    emulated: gateway.summary.emulated,
    denied: gateway.summary.denied,
    recoveryAllowed: gateway.summary.recoveryAllowed,
  });

  const common = {
    requestId,
    policy: modelPolicy,
    modelPolicy,
    measurement,
    budget,
    gateway,
    effectiveTools: gateway.effectiveTools,
    diagnostics: diagnosticsFromTrace(requestId, modelKey, provider, trace),
    trace,
    traceSummary: summarizeTrace(trace),
  };

  if (budget.action === 'reject') {
    const response = buildOpenAIContextBudgetError(budget, displayModel);
    transition(trace, 'failed_nonretryable', { status: response.status, reason: budget.reason });
    return {
      ok: false,
      ...common,
      diagnostics: diagnosticsFromTrace(requestId, modelKey, provider, trace),
      traceSummary: summarizeTrace(trace),
      response,
    };
  }

  return {
    ok: true,
    ...common,
    request: { ...input, requestId, model: modelKey, provider, messages, tools },
    response: null,
  };
}

export { parseHermesDevinModelOutput };
