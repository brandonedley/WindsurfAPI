// Hermes ↔ WindsurfAPI/Devin strict tool policy.
//
// This module classifies declared OpenAI-compatible tools. It deliberately
// does not authorize prose/narrative recovery. If a model wants a tool, it
// must emit a structured tool_call that validates against the declared tool
// inventory.

export const TOOL_MODE = Object.freeze({
  native: 'native',
  emulated: 'emulated',
  denied: 'denied',
} as const);

export const RECOVERY_KIND = Object.freeze({
  command: 'command',
  filePath: 'filePath',
  genericArgument: 'genericArgument',
  narrativeIntent: 'narrativeIntent',
} as const);

type ToolMode = typeof TOOL_MODE[keyof typeof TOOL_MODE];
type RecoveryKind = typeof RECOVERY_KIND[keyof typeof RECOVERY_KIND] | string;

type HermesTool = string | {
  type?: string;
  name?: string;
  function?: {
    name?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
  };
};

type ClassifiedTool = {
  name: string;
  mode: ToolMode;
  reason: string;
  primaryParam: string;
  recovery: {
    command: false;
    filePath: false;
    narrativeIntent: false;
  };
  sideEffectLevel: string;
  heuristicRecoveryAllowed: false;
};

function toolNameFromTool(tool: HermesTool): string {
  if (typeof tool === 'string') return tool;
  if (tool?.type === 'function' && typeof tool.function?.name === 'string') return tool.function.name;
  if (typeof tool?.name === 'string') return tool.name;
  return '';
}

function primaryStringParam(tool: HermesTool): string {
  if (typeof tool === 'string') return 'input';
  const params = tool?.function?.parameters;
  if (!params || params.type !== 'object' || !params.properties) return 'input';
  const required = Array.isArray(params.required) ? params.required : [];
  for (const key of required) {
    if (params.properties[key]?.type === 'string') return key;
  }
  return Object.keys(params.properties).find(key => params.properties?.[key]?.type === 'string')
    || Object.keys(params.properties)[0]
    || 'input';
}

export function isRecoveryAllowed(_toolName: string, _paramName: string, _recoveryKind: RecoveryKind): false {
  return false;
}

export function classifyHermesTool(tool: HermesTool, _modelPolicy = {}, _adapterOptions = {}): ClassifiedTool {
  const name = toolNameFromTool(tool);
  return {
    name,
    mode: TOOL_MODE.emulated,
    reason: name ? 'declared_tool_structured_only' : 'invalid_or_unnamed_tool',
    primaryParam: primaryStringParam(tool),
    recovery: {
      command: false,
      filePath: false,
      narrativeIntent: false,
    },
    sideEffectLevel: 'declared_structured_only',
    heuristicRecoveryAllowed: false,
  };
}

export function classifyToolInventory(tools: HermesTool[], modelPolicy = {}, adapterOptions = {}) {
  const native: ClassifiedTool[] = [];
  const emulated: ClassifiedTool[] = [];
  const denied: ClassifiedTool[] = [];
  const all: ClassifiedTool[] = [];

  for (const tool of Array.isArray(tools) ? tools : []) {
    const classified = classifyHermesTool(tool, modelPolicy, adapterOptions);
    if (!classified.name) {
      denied.push({ ...classified, mode: TOOL_MODE.denied, reason: 'invalid_or_unnamed_tool' });
      continue;
    }
    all.push(classified);
    emulated.push(classified);
  }

  return {
    all,
    native,
    emulated,
    denied,
    recoveryAllowed: [] as ClassifiedTool[],
    summary: {
      total: all.length,
      native: native.length,
      emulated: emulated.length,
      denied: denied.length,
      recoveryAllowed: 0,
    },
  };
}
