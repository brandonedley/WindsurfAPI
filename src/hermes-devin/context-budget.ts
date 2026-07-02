import type { OpenAIErrorResponse } from './types.js';

function textLengthFromContent(content: any): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, part) => n + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

export function measureCompatRequest({ messages = [], tools = [], modelPolicy = {} as any }: any = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeTools = Array.isArray(tools) ? tools : [];
  let messageChars = 0;
  let systemChars = 0;
  let lastUserChars = 0;
  for (const m of safeMessages) {
    const len = textLengthFromContent(m?.content);
    messageChars += len;
    if (m?.role === 'system') systemChars += len;
    if (m?.role === 'user') lastUserChars = len;
  }
  let toolSchemaChars = 0;
  try {
    toolSchemaChars = JSON.stringify(safeTools).length;
  } catch {
    toolSchemaChars = 0;
  }
  return {
    modelKey: modelPolicy.modelKey || '',
    adapterMode: modelPolicy.adapterMode || 'unknown',
    messageChars,
    systemChars,
    lastUserChars,
    toolCount: safeTools.length,
    toolSchemaChars,
    totalApproxChars: messageChars + toolSchemaChars,
  };
}

export function decideContextBudget(measurement: any, modelPolicy: any = {}) {
  const m = measurement || {};
  const maxToolsFull = modelPolicy.maxToolsFull ?? 20;
  const maxLastUser = modelPolicy.maxLastUserCharsWithFullTools ?? 64_000;
  const maxTotal = modelPolicy.maxTotalCharsWithTools ?? 180_000;
  const broadTools = (m.toolCount || 0) > maxToolsFull;
  const hugeLastUser = (m.lastUserChars || 0) > maxLastUser;
  const hugeTotal = (m.totalApproxChars || 0) > maxTotal;

  if (modelPolicy.adapterMode === 'fragile_tools' && broadTools && hugeLastUser) {
    return {
      action: 'reject',
      status: 413,
      reason: 'fragile_model_huge_prompt_with_broad_tools',
      retryable: false,
      measurement: m,
      limits: { maxToolsFull, maxLastUserCharsWithFullTools: maxLastUser, maxTotalCharsWithTools: maxTotal },
    };
  }

  if (hugeTotal && broadTools) {
    return {
      action: 'reject',
      status: 413,
      reason: 'context_budget_exceeded_with_broad_tools',
      retryable: false,
      measurement: m,
      limits: { maxToolsFull, maxLastUserCharsWithFullTools: maxLastUser, maxTotalCharsWithTools: maxTotal },
    };
  }

  return {
    action: 'allow',
    status: 200,
    reason: 'within_budget',
    retryable: true,
    measurement: m,
    limits: { maxToolsFull, maxLastUserCharsWithFullTools: maxLastUser, maxTotalCharsWithTools: maxTotal },
  };
}

export function buildOpenAIContextBudgetError(decision: any, model = ''): OpenAIErrorResponse {
  const d = decision || {};
  const measurement = d.measurement || {};
  const limits = d.limits || {};
  return {
    status: d.status || 413,
    body: {
      error: {
        message: `Request too large for ${model || measurement.modelKey || 'this model'} compatibility mode: ${d.reason || 'context_budget_exceeded'} (lastUser=${measurement.lastUserChars || 0} chars, messages=${measurement.messageChars || 0} chars, tools=${measurement.toolCount || 0}, toolSchemas=${measurement.toolSchemaChars || 0} chars). Reduce prompt size or tool count before retrying.`,
        type: 'context_length_exceeded',
        code: d.reason || 'context_budget_exceeded',
        param: 'messages',
        details: { measurement, limits },
      },
    },
  };
}
