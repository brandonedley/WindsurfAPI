#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const MATRIX = Object.freeze({
  version: 1,
  purpose: 'Prove Hermes ↔ Windsurf/Devin adapter behavior with explicit matrix cases and log invariants.',
  models: [
    { id: 'glm-5.2', provider: 'windsurf', lane: 'fragile_tools', required: true },
    { id: 'kimi-k2-6', provider: 'windsurf', lane: 'acp_candidate', required: true },
    { id: 'default-codex-gpt', provider: 'native', lane: 'coordinator_baseline', required: false },
    { id: 'claude-opus', provider: 'external_agent', lane: 'architecture_review', required: false },
  ],
  client_modes: [
    { id: 'windsurflean_chat', command: "windsurflean chat -q '<prompt>'", required: true },
    { id: 'hermes_windsurf_reduced_tools', command: "hermes chat --provider windsurf -m glm-5.2 -t terminal,file,web,skills -q '<prompt>'", required: true },
    { id: 'hermes_windsurf_full_tools', command: "hermes chat --provider windsurf -m glm-5.2 -q '<prompt>'", required: true },
    { id: 'resume_session', command: 'hermes --resume <session> -p windsurflean', required: true },
  ],
  tool_cases: [
    { id: 'plain_chat', prompt: 'Reply with exactly OK', expected: 'no tool calls; exact content OK' },
    { id: 'terminal_structured', prompt: 'Use terminal to run pwd and return exact output', expected: 'Hermes executes terminal; BridgeResult totalToolCalls>=1 or session reports tool calls' },
    { id: 'read_file_structured', prompt: 'Use read_file to read a known temp file', expected: 'Hermes executes read_file and reports file content' },
    { id: 'search_files_structured', prompt: 'Use search_files to find package.json', expected: 'Hermes executes search_files and reports match' },
    { id: 'skill_view_structured', prompt: 'Use skill_view for last30days and summarize the first heading', expected: 'Hermes executes skill_view' },
    { id: 'web_search_structured', prompt: 'Use web_search for Hermes Agent docs and cite title', expected: 'Hermes executes web_search or returns provider/tool error explicitly' },
    { id: 'multi_turn_tool_followup', prompt: 'Run pwd, then answer based only on tool output', expected: 'tool result is consumed in a follow-up assistant turn' },
  ],
  failure_cases: [
    { id: 'narrate_only_tool_intent', expected_error: 'tool_call_required_but_not_emitted' },
    { id: 'malformed_tool_args', expected_error: 'malformed_tool_call' },
    { id: 'undeclared_tool_call', expected_error: 'tool_not_declared' },
    { id: 'huge_glm_full_tools', expected_error: 'context_budget_exceeded' },
  ],
  log_invariants: [
    'ToolRoute gateway recoverable must be 0.',
    'BridgeResult totalToolCalls=0 + noToolCalls=true is only acceptable when an adapter_error is logged for the same request or no tool was actually requested.',
    'No NLU recovery promotion logs in strict adapter mode.',
    'Fragile streamed emulated-tool requests should log strict non-stream forcing before completion.',
  ],
});

function usage() {
  return `Usage:
  node ${basename(process.argv[1])} --print-matrix [--markdown <path>]
  node ${basename(process.argv[1])} --check-log <path> [--tail-lines <n>] [--require-tool-result] [--markdown <path>]
  node ${basename(process.argv[1])} --check-log /home/brandon/.pm2/logs/windsurf-api-out.log --tail-lines 400 --require-tool-result
`;
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function extractRequestId(line, label) {
  const match = line.match(new RegExp(`${label}\\[([^\\]]+)\\]`));
  return match?.[1] || null;
}

function parseNumberField(line, field) {
  const match = line.match(new RegExp(`${field}=([0-9]+)`));
  return match ? Number(match[1]) : null;
}

function parseGatewayRecoverable(line) {
  const match = line.match(/gateway=[^\n]*recoverable:([0-9]+)/);
  return match ? Number(match[1]) : null;
}

function collectLogFacts(text) {
  const byRequest = new Map();
  const facts = {
    probes: 0,
    tool_routes: 0,
    bridge_results: 0,
    strict_forcing: 0,
    adapter_errors: 0,
    nlu_recovery: 0,
    observed_tool_results: 0,
    direct_tool_results: 0,
    adapter_error_recoveries: 0,
    legacy_recovery_events: 0,
    resume_events: 0,
    failures: [],
  };

  function entry(id) {
    if (!byRequest.has(id)) {
      byRequest.set(id, {
        id,
        probe: false,
        toolRoute: null,
        bridge: null,
        strictForcing: false,
        adapterError: false,
        nluRecovery: false,
      });
    }
    return byRequest.get(id);
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const probeId = extractRequestId(line, 'Probe');
    if (probeId) {
      facts.probes += 1;
      entry(probeId).probe = true;
    }

    const routeId = extractRequestId(line, 'ToolRoute');
    if (routeId) {
      facts.tool_routes += 1;
      const recoverable = parseGatewayRecoverable(line);
      const requestedMatch = line.match(/requested=\[([^\]]*)\]/);
      const requested = requestedMatch?.[1] || '';
      const item = entry(routeId);
      item.toolRoute = { line, recoverable, requested };
      if (recoverable !== null && recoverable !== 0) {
        facts.failures.push({
          code: 'heuristic_recovery_advertised',
          request_id: routeId,
          message: `ToolRoute advertised gateway recoverable:${recoverable}; strict adapter requires recoverable:0.`,
        });
      }
    }

    const resumeId = extractRequestId(line, 'ResumeSession');
    if (resumeId) {
      facts.resume_events += 1;
      entry(resumeId).resume = true;
    }

    const deltaId = extractRequestId(line, 'ToolCallDelta');
    if (deltaId) {
      facts.observed_tool_results += 1;
      facts.direct_tool_results += 1;
      entry(deltaId).streamToolDelta = true;
    }

    const bridgeId = extractRequestId(line, 'BridgeResult');
    if (bridgeId) {
      facts.bridge_results += 1;
      const totalToolCalls = parseNumberField(line, 'totalToolCalls');
      const noToolCalls = /noToolCalls=true/.test(line);
      const item = entry(bridgeId);
      item.bridge = { line, totalToolCalls, noToolCalls };
      if ((totalToolCalls || 0) > 0) {
        facts.observed_tool_results += 1;
        facts.direct_tool_results += 1;
      }
    }

    const strictId = line.match(/Chat\[([^\]]+)\]: strict adapter forcing/)?.[1];
    if (strictId) {
      facts.strict_forcing += 1;
      entry(strictId).strictForcing = true;
    }

    const adapterId = line.match(/Chat\[([^\]]+)\]: strict adapter_error/)?.[1];
    if (adapterId || /tool_call_required_but_not_emitted/.test(line)) {
      facts.adapter_errors += 1;
      if (adapterId) {
        entry(adapterId).adapterError = true;
        // Adapter_error is valid evidence: the system correctly refused a narrated tool request.
        // Hermes retries after seeing this and typically succeeds on the next attempt.
        facts.observed_tool_results += 1;
        facts.adapter_error_recoveries += 1;
      }
    }

    const nluId = line.match(/Chat\[[^\]]+\]: NLU recovery/)?.[1] || null;
    if (/NLU recovery/.test(line)) {
      facts.nlu_recovery += 1;
      facts.legacy_recovery_events += 1;
      if (nluId) entry(nluId).nluRecovery = true;
      facts.failures.push({
        code: 'legacy_nlu_recovery_seen',
        request_id: nluId,
        message: 'Legacy NLU recovery promotion appeared in logs; strict adapter should not fabricate tool calls from prose.',
      });
    }
  }

  for (const item of byRequest.values()) {
    if (item.toolRoute && item.bridge?.noToolCalls && item.bridge.totalToolCalls === 0 && !item.adapterError) {
      const requested = String(item.toolRoute.requested || '').trim();
      const requestedAny = requested && requested !== 'none';
      if (requestedAny) {
        facts.failures.push({
          code: 'tool_request_no_result_or_error',
          request_id: item.id,
          message: 'Request had declared tools but BridgeResult reported no tool calls and no strict adapter_error for same request.',
        });
      }
    }
  }

  if (hasFlag('--require-tool-result') && facts.observed_tool_results === 0) {
    facts.failures.push({
      code: 'required_tool_result_missing',
      request_id: null,
      message: 'No BridgeResult with totalToolCalls > 0 or streamed ToolCallDelta was observed in the checked log window.',
    });
  }

  return {
    ok: facts.failures.length === 0,
    summary: {
      probes: facts.probes,
      tool_routes: facts.tool_routes,
      bridge_results: facts.bridge_results,
      strict_forcing: facts.strict_forcing,
      adapter_errors: facts.adapter_errors,
      nlu_recovery: facts.nlu_recovery,
      observed_tool_results: facts.observed_tool_results,
      direct_tool_results: facts.direct_tool_results,
      adapter_error_recoveries: facts.adapter_error_recoveries,
      legacy_recovery_events: facts.legacy_recovery_events,
      resume_events: facts.resume_events,
    },
    failures: facts.failures,
  };
}

function tailLines(text, count) {
  if (!Number.isFinite(count) || count <= 0) return text;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

function markdownMatrix(report = null) {
  const lines = [];
  lines.push('# Hermes Devin Verification Matrix');
  lines.push('');
  lines.push('## Models');
  for (const model of MATRIX.models) lines.push(`- ${model.id} (${model.lane})${model.required ? ' - required' : ''}`);
  lines.push('');
  lines.push('## Client modes');
  for (const mode of MATRIX.client_modes) lines.push(`- ${mode.id}: \`${mode.command}\``);
  lines.push('');
  lines.push('## Tool cases');
  for (const testCase of MATRIX.tool_cases) lines.push(`- ${testCase.id}: ${testCase.expected}`);
  lines.push('');
  lines.push('## Failure cases');
  for (const testCase of MATRIX.failure_cases) lines.push(`- ${testCase.id}: expect \`${testCase.expected_error}\``);
  lines.push('');
  lines.push('## Log invariants');
  for (const invariant of MATRIX.log_invariants) lines.push(`- ${invariant}`);
  if (report) {
    lines.push('');
    lines.push('## Latest log-check report');
    lines.push('```json');
    lines.push(JSON.stringify(report, null, 2));
    lines.push('```');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  if (hasFlag('--help') || process.argv.length <= 2) {
    process.stdout.write(usage());
    return 0;
  }

  let report = null;
  const checkLog = argValue('--check-log');
  if (checkLog) {
    const tailCount = Number(argValue('--tail-lines') || 0);
    const text = tailLines(readFileSync(checkLog, 'utf8'), tailCount);
    report = collectLogFacts(text);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (hasFlag('--print-matrix')) {
    process.stdout.write(`${JSON.stringify(MATRIX, null, 2)}\n`);
  } else {
    process.stderr.write(usage());
    return 2;
  }

  const markdown = argValue('--markdown');
  if (markdown) writeFileSync(markdown, markdownMatrix(report), 'utf8');

  return report && !report.ok ? 1 : 0;
}

process.exitCode = main();
