import { buildAdapterErrorResponse } from './errors.js';
import type { AdapterDiagnostics, AdapterParsedOutput, ModelPolicy, OpenAIMessage, OpenAITool, OpenAIToolCall } from './types.js';

function toolName(tool: OpenAITool): string {
  return typeof tool?.function?.name === 'string' ? tool.function.name : '';
}

function declaredToolMap(tools: OpenAITool[]): Map<string, OpenAITool> {
  const map = new Map<string, OpenAITool>();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = toolName(tool);
    if (name) map.set(name, tool);
  }
  return map;
}

function makeDiagnostics(requestId: string, model: string, provider: string | null, state: string, data: Record<string, unknown> = {}): AdapterDiagnostics {
  return {
    requestId,
    model,
    provider,
    events: [{ state, at: Date.now(), data }],
  };
}

function validateArgumentsJson(args: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof args !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(args || '{}') };
  } catch {
    return { ok: false };
  }
}

function validateRequiredArguments(tool: OpenAITool, value: unknown): { ok: true } | { ok: false; missing: string[] } {
  const required = tool.function.parameters?.required || [];
  if (!required.length) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, missing: required };
  const obj = value as Record<string, unknown>;
  const missing = required.filter(key => !(key in obj));
  return missing.length ? { ok: false, missing } : { ok: true };
}

function normalizedToolCall(call: OpenAIToolCall, index: number): OpenAIToolCall | null {
  if (!call || call.type !== 'function') return null;
  const name = call.function?.name;
  const args = call.function?.arguments;
  if (typeof name !== 'string' || !name.trim() || typeof args !== 'string') return null;
  return {
    id: call.id || `call_${index + 1}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

function textLooksLikeToolNarration(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  return /\b(?:I'll|I will|I'm going to|Let me|I need to|I should)\s+(?:run|use|call|execute|invoke|view|read)\b/i.test(s)
    || /\b(?:run|use|call|execute|invoke)\s+(?:the\s+)?(?:terminal|tool|command|engine|script)\b/i.test(s)
    || /(?:让我|我会|我将|运行|执行|调用|使用).*(?:工具|命令|终端)/.test(s);
}

export function parseHermesDevinModelOutput(input: {
  requestId: string;
  model: string;
  provider: string | null;
  text: string;
  nativeToolCalls?: OpenAIToolCall[];
  declaredTools: OpenAITool[];
  policy: ModelPolicy;
}): AdapterParsedOutput {
  const requestId = input.requestId || 'unknown';
  const model = input.model || input.policy?.modelKey || '';
  const provider = input.provider ?? input.policy?.provider ?? null;
  const declared = declaredToolMap(input.declaredTools || []);
  const rawCalls = Array.isArray(input.nativeToolCalls) ? input.nativeToolCalls : [];

  if (rawCalls.length) {
    const toolCalls: OpenAIToolCall[] = [];
    for (let i = 0; i < rawCalls.length; i++) {
      const call = normalizedToolCall(rawCalls[i], i);
      if (!call) {
        return {
          ok: false,
          response: buildAdapterErrorResponse({
            code: 'malformed_tool_call',
            status: 400,
            details: { index: i },
          }),
          diagnostics: makeDiagnostics(requestId, model, provider, 'malformed_tool_call', { index: i }),
        };
      }
      const declaredTool = declared.get(call.function.name);
      if (!declaredTool) {
        return {
          ok: false,
          response: buildAdapterErrorResponse({
            code: 'tool_not_declared',
            status: 422,
            details: { tool: call.function.name, declaredTools: [...declared.keys()] },
          }),
          diagnostics: makeDiagnostics(requestId, model, provider, 'tool_not_declared', { tool: call.function.name }),
        };
      }
      const parsedArgs = validateArgumentsJson(call.function.arguments);
      if (!parsedArgs.ok) {
        return {
          ok: false,
          response: buildAdapterErrorResponse({
            code: 'tool_arguments_invalid_json',
            status: 422,
            details: { tool: call.function.name },
          }),
          diagnostics: makeDiagnostics(requestId, model, provider, 'tool_arguments_invalid_json', { tool: call.function.name }),
        };
      }
      const required = validateRequiredArguments(declaredTool, parsedArgs.value);
      if (!required.ok) {
        const missing = 'missing' in required ? required.missing : [];
        return {
          ok: false,
          response: buildAdapterErrorResponse({
            code: 'tool_arguments_schema_mismatch',
            status: 422,
            details: { tool: call.function.name, missing },
          }),
          diagnostics: makeDiagnostics(requestId, model, provider, 'tool_arguments_schema_mismatch', { tool: call.function.name, missing }),
        };
      }
      toolCalls.push(call);
    }

    const message: OpenAIMessage = {
      role: 'assistant',
      content: input.text || null,
      tool_calls: toolCalls,
    };
    return {
      ok: true,
      message,
      toolCalls,
      diagnostics: makeDiagnostics(requestId, model, provider, 'parsed_native_tool_calls', { count: toolCalls.length }),
    };
  }

  if ((input.declaredTools || []).length && textLooksLikeToolNarration(input.text || '')) {
    return {
      ok: false,
      response: buildAdapterErrorResponse({
        code: 'tool_call_required_but_not_emitted',
        status: 400,
        details: { head: String(input.text || '').slice(0, 240) },
      }),
      diagnostics: makeDiagnostics(requestId, model, provider, 'tool_call_required_but_not_emitted'),
    };
  }

  return {
    ok: true,
    message: { role: 'assistant', content: input.text || '' },
    toolCalls: [],
    diagnostics: makeDiagnostics(requestId, model, provider, 'assistant_text_only'),
  };
}
