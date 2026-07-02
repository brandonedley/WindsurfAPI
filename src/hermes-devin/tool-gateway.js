// @ts-nocheck
import { classifyHermesTool, TOOL_MODE } from './tool-policy.js';
function toolName(tool) {
    if (typeof tool === 'string')
        return tool;
    return tool?.function?.name || tool?.name || '';
}
function normalize(value) {
    return String(value || '').trim().toLowerCase();
}
function buildCertification(classified, effectiveTools, inputTools) {
    const byOwner = Object.create(null);
    const unknown = [];
    for (const tool of classified) {
        if (tool.executionOwner)
            byOwner[tool.executionOwner] = (byOwner[tool.executionOwner] || 0) + 1;
        else
            unknown.push(tool.name || '(unnamed)');
    }
    const effectiveNames = new Set(effectiveTools.map(toolName).filter(Boolean));
    const inputNames = (Array.isArray(inputTools) ? inputTools : []).map(toolName).filter(Boolean);
    const dropped = inputNames.filter(name => !effectiveNames.has(name));
    return {
        total: classified.length,
        dropped,
        unknown,
        byOwner,
    };
}
/**
 * Build the deterministic Hermes↔Devin declared-tool gateway.
 *
 * Important distinction:
 * - Declared tools: all valid OpenAI function tools must remain available to
 *   the Hermes loop. The adapter may surface a model-emitted tool_call for
 *   `memory`, `patch`, `send_message`, etc. Hermes owns execution.
 * - Heuristic recovery: only a tiny allowlist can be fabricated from prose.
 *   Stateful/external tools are never recovered heuristically.
 */
export function buildHermesDevinToolGateway(tools = [], options = {}) {
    const nativeNames = new Set((options.nativeToolNames || []).map(normalize));
    const classified = [];
    const native = [];
    const emulated = [];
    const denied = [];
    const effectiveTools = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
        const name = toolName(tool);
        if (!name || tool?.type !== 'function') {
            denied.push({ name, mode: TOOL_MODE.denied, reason: 'invalid_or_non_function_tool' });
            continue;
        }
        const info = classifyHermesTool(tool, options.modelPolicy || {}, options);
        const routed = nativeNames.has(normalize(name))
            ? {
                ...info,
                mode: TOOL_MODE.native,
                reason: 'native_bridge_mapped',
                executionOwner: 'cascade_native_bridge',
                heuristicRecoveryAllowed: !!(info.recovery?.command || info.recovery?.filePath || info.recovery?.narrativeIntent),
            }
            : {
                ...info,
                executionOwner: 'hermes_tool_executor',
                heuristicRecoveryAllowed: !!(info.recovery?.command || info.recovery?.filePath || info.recovery?.narrativeIntent),
            };
        classified.push(routed);
        effectiveTools.push(tool);
        if (routed.mode === TOOL_MODE.native)
            native.push(routed);
        else if (routed.mode === TOOL_MODE.denied)
            denied.push(routed);
        else
            emulated.push(routed);
    }
    return {
        effectiveTools,
        classified,
        native,
        emulated,
        denied,
        recoveryAllowed: classified.filter(t => t.recovery?.command || t.recovery?.filePath || t.recovery?.narrativeIntent),
        certification: buildCertification(classified, effectiveTools, tools),
        summary: {
            declared: classified.length,
            effective: effectiveTools.length,
            native: native.length,
            emulated: emulated.length,
            denied: denied.length,
            recoveryAllowed: classified.filter(t => t.recovery?.command || t.recovery?.filePath || t.recovery?.narrativeIntent).length,
        },
    };
}
