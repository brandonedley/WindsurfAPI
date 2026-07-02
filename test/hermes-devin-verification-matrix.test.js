import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = 'scripts/hermes-devin-verify-matrix.mjs';

function run(args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-devin-verify-'));
  const path = join(dir, 'proxy.log');
  writeFileSync(path, content);
  return path;
}

describe('Hermes Devin verification matrix tooling', () => {
  it('prints the canonical matrix as JSON', () => {
    const result = run(['--print-matrix']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const matrix = JSON.parse(result.stdout);
    assert.ok(matrix.version >= 1);
    assert.ok(matrix.models.some((model) => model.id === 'glm-5.2'));
    assert.ok(matrix.tool_cases.some((testCase) => testCase.id === 'terminal_structured'));
    assert.ok(matrix.failure_cases.some((testCase) => testCase.expected_error === 'tool_call_required_but_not_emitted'));
    assert.ok(matrix.client_modes.some((mode) => mode.id === 'windsurflean_chat'));
  });

  it('passes a strict log containing budget, route, tool result, and no legacy recovery', () => {
    const log = tmpFile(`
[INFO] Probe[abc123]: model=glm-5.2 stream=true rf=none tools=11 reasoning=none ctypes=[string] turns=2 lastUser=len=80 hash=abc
[INFO] ToolRoute[abc123]: requested=[terminal,read_file] effective=[terminal,read_file] mapped=[none] unmapped=[terminal,read_file] native=off nativeReason=native_bridge_off gateway=native:0/emulated:2/denied:0/recoverable:0 preamble=full/23KB forced=none reasons=[native_bridge_off,preamble_full]
[INFO] Chat[abc123]: strict adapter forcing non-stream response for fragile emulated tool request so adapter_error can be returned before streaming commits
[INFO] BridgeResult[abc123]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=1 totalToolCalls=1 noToolCalls=false argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[terminal]
`);
    const result = run(['--check-log', log]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.tool_routes, 1);
    assert.equal(report.summary.bridge_results, 1);
  });

  it('fails logs that still advertise heuristic recovery privileges', () => {
    const log = tmpFile(`
[INFO] Probe[bad111]: model=glm-5.2 stream=true rf=none tools=11 reasoning=none ctypes=[string] turns=2 lastUser=len=80 hash=abc
[INFO] ToolRoute[bad111]: requested=[terminal,read_file] effective=[terminal,read_file] mapped=[none] unmapped=[terminal,read_file] native=off nativeReason=native_bridge_off gateway=native:0/emulated:2/denied:0/recoverable:2 preamble=full/23KB forced=none reasons=[native_bridge_off,preamble_full]
[INFO] BridgeResult[bad111]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=0 totalToolCalls=0 noToolCalls=true argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[none]
`);
    const result = run(['--check-log', log]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((failure) => failure.code === 'heuristic_recovery_advertised'));
  });

  it('fails logs where a narrated tool request produced no tool call and no adapter_error', () => {
    const log = tmpFile(`
[INFO] Probe[bad222]: model=glm-5.2 stream=true rf=none tools=11 reasoning=none ctypes=[string] turns=2 lastUser=len=80 hash=abc
[INFO] ToolRoute[bad222]: requested=[terminal,read_file] effective=[terminal,read_file] mapped=[none] unmapped=[terminal,read_file] native=off nativeReason=native_bridge_off gateway=native:0/emulated:2/denied:0/recoverable:0 preamble=full/23KB forced=none reasons=[native_bridge_off,preamble_full]
[INFO] BridgeResult[bad222]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=0 totalToolCalls=0 noToolCalls=true argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[none]
`);
    const result = run(['--check-log', log]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.failures.some((failure) => failure.code === 'tool_request_no_result_or_error'));
  });

  it('can restrict checks to the latest N lines so stale historical failures do not poison current verification', () => {
    const log = tmpFile(`
[INFO] ToolRoute[oldbad]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:1
[INFO] BridgeResult[oldbad]: bridgeEnabled=false totalToolCalls=0 noToolCalls=true
[INFO] ToolRoute[newgood]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] BridgeResult[newgood]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=1 totalToolCalls=1 noToolCalls=false argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[terminal]
`);
    const result = run(['--check-log', log, '--tail-lines', '2']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.tool_routes, 1);
  });

  it('can require at least one observed tool result in the checked log window', () => {
    const emptyLog = tmpFile(`
[INFO] ToolRoute[nobridge]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
`);
    const fail = run(['--check-log', emptyLog, '--require-tool-result']);
    assert.notEqual(fail.status, 0);
    const failedReport = JSON.parse(fail.stdout);
    assert.ok(failedReport.failures.some((failure) => failure.code === 'required_tool_result_missing'));

    const goodLog = tmpFile(`
[INFO] ToolRoute[withbridge]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] BridgeResult[withbridge]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=1 totalToolCalls=1 noToolCalls=false argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[terminal]
`);
    const pass = run(['--check-log', goodLog, '--require-tool-result']);
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  });

  it('counts streamed ToolCallDelta logs as observed tool results', () => {
    const log = tmpFile(`
[INFO] ToolRoute[streamtool]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] ToolCallDelta[streamtool]: index=0 name=terminal source=stream
`);
    const result = run(['--check-log', log, '--require-tool-result']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.observed_tool_results, 1);
  });


  it('distinguishes direct tool success from adapter-error recovery in summaries', () => {
    const log = tmpFile(`
[INFO] ToolRoute[direct1]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] BridgeResult[direct1]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=1 totalToolCalls=1 noToolCalls=false argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[terminal]
[INFO] ToolRoute[recover1]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] Chat[recover1]: strict adapter_error — fragile model glm-5.2 narrated tool intent without structured tool_calls
`);
    const result = run(['--check-log', log, '--require-tool-result']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.direct_tool_results, 1);
    assert.equal(report.summary.adapter_error_recoveries, 1);
    assert.equal(report.summary.legacy_recovery_events, 0);
    assert.equal(report.summary.observed_tool_results, 2);
  });

  it('counts resume events when visible in logs', () => {
    const log = tmpFile(`
[INFO] ResumeSession[resume1]: session=20260101_000000_deadbe profile=windsurflean
[INFO] ToolRoute[resume1]: requested=[terminal] effective=[terminal] mapped=[none] unmapped=[terminal] native=off gateway=native:0/emulated:1/denied:0/recoverable:0
[INFO] BridgeResult[resume1]: bridgeEnabled=false cascadeToolCalls=0 mappedToolCalls=0 unmappedToolCalls=0 emulatedToolCalls=1 totalToolCalls=1 noToolCalls=false argParseFailures=0 reverseFailures=0 cascadeKinds=[none] mapped=[none] unmapped=[none] emulated=[terminal]
`);
    const result = run(['--check-log', log, '--require-tool-result']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.resume_events, 1);
  });

  it('can write a markdown plan/report artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-devin-report-'));
    const out = join(dir, 'report.md');
    const result = run(['--print-matrix', '--markdown', out]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const content = readFileSync(out, 'utf8');
    assert.match(content, /# Hermes Devin Verification Matrix/);
    assert.match(content, /terminal_structured/);
    assert.match(content, /tool_call_required_but_not_emitted/);
  });
});
