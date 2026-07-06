/**
 * Backend router — makes the implicit "which backend" decision explicit.
 *
 * Historically the backend choice was scattered across handlers/chat.js and
 * special-agent.js as inline branches. This module centralizes that decision
 * into one pure function so the multi-backend migration (Cascade ↔ Devin) has
 * a single, testable seam.
 *
 * BEHAVIOUR-PRESERVING: as of P1 this returns exactly what the inline logic in
 * chat.js:1789-1806 produced. No new routing is introduced yet — Devin REST is
 * defined as a backend constant but only selected when explicitly enabled via
 * env, which defaults OFF. Later phases (P2/P3) extend selectBackend() with
 * entitlement + availability inputs without touching the call sites.
 *
 * Decision order (matches legacy):
 *   1. modelInfo.backend === 'special_agent'         → BACKEND.DEVIN_ACP / DEVIN_PRINT
 *      (the special-agent path; its sub-mode comes from DEVIN_CLI_MODE)
 *   2. modelUid (string) OR enumValue > 0             → BACKEND.CASCADE
 *   3. otherwise                                       → BACKEND.LEGACY
 */

export const BACKEND = Object.freeze({
  CASCADE: 'cascade',        // Connect-RPC → server.codeium.com (StartCascade flow)
  LEGACY: 'legacy',          // RawGetChatMessage (deprecated, enum-only models)
  DEVIN_ACP: 'devin-acp',    // Devin CLI ACP over stdio (special-agent, mode=acp)
  DEVIN_PRINT: 'devin-print',// Devin CLI print mode (special-agent, mode=print)
  DEVIN_REST: 'devin-rest',  // Devin DRS REST → api.devin.ai (P2+, not yet wired)
  GETCHATMESSAGE: 'getchatmessage-native', // cloud ApiServerService/GetChatMessage — TRUE model
                             // selection (chat_model_uid) + native tools[] on the same
                             // transport the Devin CLI (chisel) uses. Not Cascade: it
                             // survives the Cascade decommission. Flag-gated via
                             // WINDSURFAPI_GETCHATMESSAGE_TOOLS=1.
  DEVIN_CONNECT: 'devin-connect', // Direct cloud GetChatMessage over pure HTTP
                                  // (no local CLI) → server.codeium.com. See
                                  // src/devin-connect.js + devin-connect-openai.js.
});

/**
 * Is the given model info routed to the special-agent (Devin CLI) backend?
 * Mirrors special-agent.js isSpecialAgentModelInfo without importing it, to
 * keep this module free of side effects.
 */
function isSpecialAgentInfo(modelInfo) {
  return modelInfo?.backend === 'special_agent';
}

/**
 * Resolve the Devin CLI sub-mode (acp vs print). Defaults to print — the same
 * conservative default special-agent.js uses.
 */
function devinCliMode(env = process.env) {
  const mode = String(env.DEVIN_CLI_MODE || 'print').trim().toLowerCase();
  return mode === 'acp' ? BACKEND.DEVIN_ACP : BACKEND.DEVIN_PRINT;
}

/**
 * DEVIN_ONLY kill-switch. When set, Cascade is fully retired and EVERY request
 * — regardless of model — is routed through the Devin CLI special-agent
 * backend. This is the "Devin is the only core" mode for after the Cascade
 * upstream is decommissioned. Defaults OFF, so behaviour is unchanged until an
 * operator flips it.
 *
 * NOTE (unverified, needs live probe): routing a model like claude-4.5-sonnet
 * here makes Devin the *nominal* backend, but the current ACP path only passes
 * the requested model name as a prompt hint (devin-acp.js session/prompt) — it
 * does NOT switch Devin's underlying core to that model. Whether Devin can
 * actually serve a specific model is an open question gated on a live probe.
 */
function devinOnlyEnabled(env = process.env) {
  return String(env.DEVIN_ONLY || '').trim() === '1';
}

/**
 * Native GetChatMessage transport gate. Flag-on + a cascade-uid model + a
 * tools[] request → serve via the cloud ApiServerService/GetChatMessage
 * endpoint with a NATIVE tools schema (no prompt emulation). This is the
 * DEVIN_ONLY known-gap fix: unlike the ACP path (model name is only a prompt
 * hint; Devin answers with its own SWE core), GetChatMessage carries
 * chat_model_uid, so the requested model actually serves the request.
 */
function getChatMessageToolsEnabled(env = process.env) {
  return String(env.WINDSURFAPI_GETCHATMESSAGE_TOOLS || '').trim() === '1';
}

/**
 * WINDSURFAPI_GETCHATMESSAGE_ALL=1 widens the native transport to requests
 * WITHOUT tools[] (plain chat), making cascade-uid models fully independent
 * of the Cascade upstream before its decommission. The empty-tools request is
 * already supported by the encoder (live-validated text turn: stop_reason=2).
 * Requires the base TOOLS flag — ALL widens the transport, it does not enable it.
 */
function getChatMessageAllEnabled(env = process.env) {
  return String(env.WINDSURFAPI_GETCHATMESSAGE_ALL || '').trim() === '1';
}

/**
 * DEVIN_CONNECT kill-switch. When set, every request is served by the direct
 * cloud GetChatMessage path (src/devin-connect.js) — pure HTTP to
 * server.codeium.com with NO local Devin CLI subprocess. This is the deploy
 * mode for hosts that have the Windsurf session token but can't (or shouldn't)
 * run the CLI. Defaults OFF.
 *
 * Wins over DEVIN_ONLY (CLI) and all model-based routing: when an operator opts
 * into the pure-HTTP egress they mean it for the whole process. The model name
 * still flows through unchanged so devin-connect maps it to the upstream
 * selector (field #21). Verified working on a free account with swe-1-6-* (see
 * memory: devin-connect-WORKING-recipe-2026-06-30); claude-* selectors are
 * gated on a paid-account probe.
 */
function devinConnectEnabled(env = process.env) {
  return String(env.DEVIN_CONNECT || '').trim() === '1';
}

/**
 * Select the backend for a request. Pure function — no I/O, no mutation.
 *
 * @param {object} params
 * @param {object|null} params.modelInfo  resolved model catalog entry
 * @param {Array|null}  [params.tools]    request tools[] (native transport input)
 * @param {boolean}     [params.modelSupportsTools] catalog supports_tool_calls
 * @param {object} [params.env]           env source (injectable for tests)
 * @returns {{ backend: string, reason: string, flow: 'special_agent'|'cascade'|'legacy'|'getchatmessage'|'devin_connect' }}
 */
export function selectBackend({ modelInfo = null, tools = null, modelSupportsTools = false, env = process.env } = {}) {
  // Native GetChatMessage wins over everything INCLUDING DEVIN_ONLY and
  // DEVIN_CONNECT: it is not Cascade (survives the decommission), it does true
  // model selection, and it is the transport live traffic runs on today. Both
  // gates are explicit opt-in flags; when both are set the more specific
  // per-request gate (tools/model aware) beats the process-wide kill-switch.
  if (getChatMessageToolsEnabled(env)
    && modelSupportsTools
    && ((Array.isArray(tools) && tools.length > 0) || getChatMessageAllEnabled(env))
    && modelInfo?.modelUid && !isSpecialAgentInfo(modelInfo)) {
    return {
      backend: BACKEND.GETCHATMESSAGE,
      reason: (Array.isArray(tools) && tools.length > 0) ? 'getchatmessage_tools_flag' : 'getchatmessage_all_flag',
      flow: 'getchatmessage',
    };
  }

  // DEVIN_CONNECT: pure-HTTP cloud egress retires both Cascade AND the local
  // CLI. Wins over DEVIN_ONLY and all model-based routing below — an operator
  // who flips this wants every request on the direct GetChatMessage path.
  if (devinConnectEnabled(env)) {
    return {
      backend: BACKEND.DEVIN_CONNECT,
      reason: 'devin_connect',
      flow: 'devin_connect',
    };
  }

  // DEVIN_ONLY: Cascade is retired — force every request onto Devin. This wins
  // over all model-based routing below. The sub-mode (acp/print) still comes
  // from DEVIN_CLI_MODE so the existing runner selection is preserved.
  if (devinOnlyEnabled(env)) {
    return {
      backend: devinCliMode(env),
      reason: 'devin_only',
      flow: 'special_agent',
    };
  }

  if (isSpecialAgentInfo(modelInfo)) {
    return {
      backend: devinCliMode(env),
      reason: 'modelInfo.backend=special_agent',
      flow: 'special_agent',
    };
  }

  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  if (modelUid || modelEnum) {
    return { backend: BACKEND.CASCADE, reason: modelUid ? 'modelUid' : 'enumValue', flow: 'cascade' };
  }

  return { backend: BACKEND.LEGACY, reason: 'no-uid-no-enum', flow: 'legacy' };
}

/**
 * Convenience: does this selection use the Cascade Connect-RPC flow? Call sites
 * in chat.js currently compute `useCascade = !!(modelUid || modelEnum)`; this
 * keeps that exact semantics so the router can be dropped in without behaviour
 * change.
 */
export function usesCascadeFlow(selection) {
  return selection?.flow === 'cascade';
}

export const __testing = { isSpecialAgentInfo, devinCliMode, devinOnlyEnabled, devinConnectEnabled };
