export type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | string;

export type OpenAIMessageContent = string | Array<{ type?: string; text?: string; [key: string]: unknown }> | null;

export type OpenAIMessage = {
  role: ChatRole;
  content?: OpenAIMessageContent;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, { type?: string; [key: string]: unknown }>;
      required?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export type OpenAIToolCall = {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AdapterErrorCode =
  | 'context_budget_exceeded'
  | 'tool_count_budget_exceeded'
  | 'tool_call_required_but_not_emitted'
  | 'malformed_tool_call'
  | 'tool_not_declared'
  | 'tool_arguments_invalid_json'
  | 'tool_arguments_schema_mismatch'
  | 'unsafe_recovery_refused'
  | 'unsupported_tool_protocol';

export type OpenAIErrorResponse = {
  status: number;
  body: {
    error: {
      message: string;
      type: 'adapter_error' | 'context_length_exceeded';
      code: AdapterErrorCode | string;
      param?: string;
      details?: Record<string, unknown>;
    };
  };
};

export type ModelPolicy = {
  modelKey: string;
  provider: string | null;
  adapterMode: string;
  preferredBackend: string;
  preferredDialect: string;
  maxToolsFull: number;
  maxLastUserCharsWithFullTools: number;
  maxTotalCharsWithTools: number;
  maxRecoveryAttempts: number;
  allowGenericNarrativeRecovery: boolean;
  allowNativeBridge: boolean;
};


export type HermesToolGateway = {
  effectiveTools: OpenAITool[];
  classified: Array<Record<string, any>>;
  native: Array<Record<string, any>>;
  emulated: Array<Record<string, any>>;
  denied: Array<Record<string, any>>;
  recoveryAllowed?: Array<Record<string, any>>;
  certification: { total: number; dropped: string[]; unknown: string[]; byOwner: Record<string, number> };
  summary: { declared?: number; effective?: number; total?: number; native: number; emulated: number; denied: number; recoveryAllowed: number };
};

export type CompatTrace = {
  events: Array<{ state: string; at?: number; data?: Record<string, unknown> }>;
  [key: string]: unknown;
};

export type AdapterDiagnostics = {
  requestId: string;
  model: string;
  provider: string | null;
  events: Array<{ state: string; at: number; data?: Record<string, unknown> }>;
  summary?: Record<string, unknown>;
};

export type AdapterInput = {
  requestId: string;
  model?: string;
  modelKey?: string;
  provider?: string | null;
  messages: OpenAIMessage[];
  tools: OpenAITool[];
  stream?: boolean;
  displayModel?: string;
  nativeToolNames?: string[];
};

export type AdapterPrepared =
  | {
      ok: true;
      requestId: string;
      request: AdapterInput;
      policy: ModelPolicy;
      modelPolicy: ModelPolicy;
      measurement: Record<string, unknown>;
      budget: Record<string, unknown>;
      gateway: HermesToolGateway;
      effectiveTools: OpenAITool[];
      diagnostics: AdapterDiagnostics;
      trace: CompatTrace;
      traceSummary: Record<string, unknown>;
      response: null;
    }
  | {
      ok: false;
      requestId: string;
      policy: ModelPolicy;
      modelPolicy: ModelPolicy;
      measurement: Record<string, unknown>;
      budget: Record<string, unknown>;
      gateway: HermesToolGateway;
      effectiveTools: OpenAITool[];
      diagnostics: AdapterDiagnostics;
      trace: CompatTrace;
      traceSummary: Record<string, unknown>;
      response: OpenAIErrorResponse;
    };

export type AdapterParsedOutput =
  | {
      ok: true;
      message: OpenAIMessage;
      toolCalls: OpenAIToolCall[];
      diagnostics: AdapterDiagnostics;
    }
  | {
      ok: false;
      response: OpenAIErrorResponse;
      diagnostics: AdapterDiagnostics;
    };
