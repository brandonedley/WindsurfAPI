// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { runDevinAcpProcess } from '../devin-acp.js';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function declaredToolNames(tools) {
  return new Set((Array.isArray(tools) ? tools : [])
    .map(t => t?.function?.name || t?.name)
    .filter(Boolean));
}

export function openAIMessageToDevinPromptText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      const role = message?.role || 'user';
      const name = message?.name ? ` ${message.name}` : '';
      const text = contentText(message?.content);
      return text ? `${role}${name}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildSessionNewRequest(options = {}) {
  return {
    jsonrpc: '2.0',
    id: options.id ?? 2,
    method: 'session/new',
    params: {
      model: options.model || options.modelKey || 'adaptive',
      mode: options.mode || 'agent',
      metadata: options.metadata || {},
    },
  };
}

export function buildSessionPromptRequest(options = {}) {
  if (!options.sessionId) throw new Error('sessionId is required for Devin ACP session/prompt');
  const text = options.prompt || openAIMessageToDevinPromptText(options.messages || []);
  return {
    jsonrpc: '2.0',
    id: options.id ?? 3,
    method: 'session/prompt',
    params: {
      sessionId: options.sessionId,
      prompt: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

export function normalizeAcpNotificationsToOpenAI(notifications = []) {
  const chunks = [];
  for (const event of Array.isArray(notifications) ? notifications : []) {
    if (event?.method !== 'agent_message_chunk') continue;
    const params = event.params || {};
    const text = typeof params.text === 'string' ? params.text
      : typeof params.chunk === 'string' ? params.chunk
        : typeof params.delta === 'string' ? params.delta
          : '';
    if (text) chunks.push(text);
  }
  return chunks.join('');
}

export function normalizeAcpToolRequestToOpenAIToolCall(event, declaredTools = []) {
  const params = event?.params || {};
  const name = params.name || params.toolName || params.tool?.name;
  if (!name || !declaredToolNames(declaredTools).has(name)) return null;
  return {
    id: params.id || params.toolCallId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(params.arguments || params.args || params.input || {}),
    },
  };
}

export function shouldUseHermesDevinAcpBackend(input = {}, env = process.env) {
  if (env?.HERMES_DEVIN_ACP_BACKEND !== '1') return false;
  const requested = String(input.backend || input.__backend || input.__hermesDevinBackend || env?.HERMES_DEVIN_BACKEND || '').trim().toLowerCase();
  return !requested || requested === 'acp' || requested === 'devin-acp' || requested === 'hermes-devin-acp';
}

function usageFromAcp(result) {
  const usage = result?.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export async function executeHermesDevinAcpChat(input = {}, deps = {}) {
  const env = input.env || process.env;
  if (!shouldUseHermesDevinAcpBackend(input, env)) return null;

  const tools = Array.isArray(input.tools) ? input.tools : [];
  if (tools.length && env.HERMES_DEVIN_ACP_ALLOW_TOOLS !== '1') {
    return {
      status: 400,
      body: {
        error: {
          message: 'Hermes Devin ACP backend is enabled, but live ACP tool execution is still gated. Set HERMES_DEVIN_ACP_ALLOW_TOOLS=1 only after wiring a safe tool-execution bridge.',
          type: 'unsupported_tool_boundary',
          code: 'acp_tools_not_enabled',
        },
      },
    };
  }

  const account = input.account || {};
  if (!account.apiKey) {
    return {
      status: 503,
      body: {
        error: {
          message: 'Hermes Devin ACP backend requires a checked-out upstream account apiKey.',
          type: 'backend_unavailable',
          code: 'acp_account_unavailable',
        },
      },
    };
  }

  const runAcp = deps.runAcp || runDevinAcpProcess;
  const model = input.model || input.modelKey || 'devin-acp';
  const prompt = input.prompt || openAIMessageToDevinPromptText(input.messages || []);
  const result = await runAcp(prompt, {
    modelKey: input.modelKey || model,
    apiKey: account.apiKey,
    apiServerUrl: account.apiServerUrl || '',
    signal: input.signal || null,
  });
  const text = String(result?.text || '').trim();
  const id = input.id || `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 29)}`;
  const created = input.created || Math.floor(Date.now() / 1000);
  return {
    status: 200,
    body: {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: usageFromAcp(result),
    },
  };
}
