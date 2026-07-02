import type { AdapterErrorCode, OpenAIErrorResponse } from './types.js';

const DEFAULT_MESSAGES: Record<AdapterErrorCode, string> = {
  context_budget_exceeded: 'Request exceeds the compatibility context budget.',
  tool_count_budget_exceeded: 'Request declares too many tools for this compatibility mode.',
  tool_call_required_but_not_emitted: 'Model narrated tool intent but emitted no structured tool_call.',
  malformed_tool_call: 'Model emitted a malformed tool_call envelope.',
  tool_not_declared: 'Model emitted a tool_call for a tool that was not declared in the request.',
  tool_arguments_invalid_json: 'Model emitted tool_call arguments that are not valid JSON.',
  tool_arguments_schema_mismatch: 'Model emitted tool_call arguments that do not satisfy the declared tool schema.',
  unsafe_recovery_refused: 'Adapter refused to synthesize a tool call from prose.',
  unsupported_tool_protocol: 'Model output used an unsupported tool protocol.',
};

export function buildAdapterErrorResponse({
  code,
  status = 400,
  message,
  param = 'messages',
  details = {},
}: {
  code: AdapterErrorCode;
  status?: number;
  message?: string;
  param?: string;
  details?: Record<string, unknown>;
}): OpenAIErrorResponse {
  return {
    status,
    body: {
      error: {
        message: message || DEFAULT_MESSAGES[code],
        type: 'adapter_error',
        code,
        param,
        details,
      },
    },
  };
}
