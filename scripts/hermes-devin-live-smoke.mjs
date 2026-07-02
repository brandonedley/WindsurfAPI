#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_LOG = '/home/brandon/.pm2/logs/windsurf-api-out.log';
const DEFAULT_PROFILE = 'windsurflean';

const CASES = Object.freeze([
  {
    id: 'plain_chat',
    group: 'basic',
    mode: 'windsurflean',
    prompt: 'Reply with exactly OK.',
    require_tool_result: false,
    evidence_type: 'none',
    expected_output: /\bOK\b/i,
    description: 'Plain chat should not need tool execution.',
  },
  {
    id: 'terminal_pwd',
    group: 'basic',
    mode: 'windsurflean',
    prompt: 'Use the terminal tool to run: pwd. Then answer with the exact directory printed.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /\/home\/brandon\/dev\/windsurf\/WindsurfAPI/,
    description: 'Terminal tool smoke: model must produce or retry into a structured terminal call.',
  },
  {
    id: 'read_file_package',
    group: 'basic',
    mode: 'windsurflean',
    prompt: 'Use the read_file tool to read package.json. Then answer with only the package name value.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /windsurf-api/,
    description: 'File-read smoke: model must call read_file and consume the result.',
  },
  {
    id: 'search_files_package',
    group: 'basic',
    mode: 'windsurflean',
    prompt: 'Use the search_files tool to find package.json in the current repository. Then answer with the matching path.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /package\.json/,
    description: 'Search smoke: model must call search_files and consume the result.',
  },
  {
    id: 'multi_turn_terminal_followup',
    group: 'full',
    mode: 'windsurflean',
    prompt: 'Use the terminal tool to run: pwd. Then, in a follow-up assistant turn, answer with exactly: TOOL_OUTPUT=<directory>.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /TOOL_OUTPUT=\/home\/brandon\/dev\/windsurf\/WindsurfAPI|\/home\/brandon\/dev\/windsurf\/WindsurfAPI/,
    description: 'Tool result must be consumed in the assistant answer after execution.',
  },
  {
    id: 'stateful_tool_boundary',
    group: 'full',
    mode: 'windsurflean',
    prompt: 'Do not modify memory or todos. Use the terminal tool to run: printf STATEFUL_BOUNDARY_OK. Then answer with exactly STATEFUL_BOUNDARY_OK.',
    require_tool_result: true,
    evidence_type: 'boundary',
    expected_output: /STATEFUL_BOUNDARY_OK/,
    description: 'Stateful tools remain declared but must not be prose-recovered or accidentally invoked.',
  },
  {
    id: 'web_search_smoke',
    group: 'full',
    mode: 'windsurflean',
    prompt: 'Use the web_search tool to search for Hermes Agent documentation. Then answer with a result title or explicit tool error.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /Hermes|documentation|docs|tool error|error/i,
    description: 'Network/web tool path smoke. Provider/tool errors are acceptable only when explicit.',
  },
  {
    id: 'hermes_reduced_tools_smoke',
    group: 'full',
    mode: 'hermes_reduced',
    prompt: 'Use the terminal tool to run: pwd. Then answer with the exact directory printed.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /\/home\/brandon\/dev\/windsurf\/WindsurfAPI/,
    description: 'Hermes windsurf reduced-tool mode smoke.',
  },
  {
    id: 'full_tool_hermes_smoke',
    group: 'full',
    mode: 'hermes_full',
    prompt: 'Use the terminal tool to run: pwd. Then answer with the exact directory printed.',
    require_tool_result: true,
    evidence_type: 'direct_or_recovery',
    expected_output: /\/home\/brandon\/dev\/windsurf\/WindsurfAPI|context_budget_exceeded|adapter_error/i,
    description: 'Hermes windsurf full-tool mode. May classify context-budget/adapter failure explicitly.',
  },
  {
    id: 'resume_session_smoke',
    group: 'full',
    mode: 'resume',
    prompt: 'Now answer with exactly RESUME_OK.',
    require_tool_result: false,
    evidence_type: 'resume',
    expected_output: /RESUME_OK|OK|\/home\/brandon\/dev\/windsurf\/WindsurfAPI/i,
    description: 'Resume a previously captured Hermes session and verify it responds cleanly.',
  },
]);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function values(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

function value(flag, fallback = null) {
  const all = values(flag);
  return all.length ? all[all.length - 1] : fallback;
}

function shellQuote(input) {
  return `'${String(input).replace(/'/g, `'"'"'`)}'`;
}

function usage() {
  return `Usage:
  node ${basename(process.argv[1])} --print-cases
  node ${basename(process.argv[1])} --dry-run [--case <id> ...] [--resume-session <id>]
  node ${basename(process.argv[1])} [--case <id> ...] [--profile windsurflean] [--resume-session <id>] [--log <path>] [--tail-lines <n>]

Groups:
  --case basic  => plain_chat, terminal_pwd, read_file_package, search_files_package
  --case full   => all full matrix cases
  --case all    => all cases
`;
}

function expandCaseToken(token) {
  if (token === 'all') return CASES.map((testCase) => testCase.id);
  if (token === 'basic') return CASES.filter((testCase) => testCase.group === 'basic').map((testCase) => testCase.id);
  if (token === 'full') return CASES.filter((testCase) => testCase.group === 'basic' || testCase.group === 'full').map((testCase) => testCase.id);
  return [token];
}

function selectCases() {
  const requestedRaw = values('--case');
  const requested = requestedRaw.length ? requestedRaw.flatMap(expandCaseToken) : expandCaseToken('basic');
  const seen = new Set();
  const selected = [];
  const failures = [];
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    const testCase = CASES.find((candidate) => candidate.id === id);
    if (!testCase) failures.push({ code: 'unknown_case', message: `Unknown live smoke case: ${id}`, case: id });
    else selected.push(testCase);
  }
  return { selected, failures };
}

function commandSpecFor(testCase, opts = {}) {
  const profile = opts.profile || DEFAULT_PROFILE;
  const resumeSession = opts.resumeSession || null;
  switch (testCase.mode) {
    case 'windsurflean':
      return { executable: 'windsurflean', args: ['chat', '-q', testCase.prompt] };
    case 'hermes_reduced':
      return { executable: 'hermes', args: ['chat', '--provider', 'windsurf', '-m', 'glm-5.2', '-t', 'terminal,file,web,skills', '-q', testCase.prompt] };
    case 'hermes_full':
      return { executable: 'hermes', args: ['chat', '--provider', 'windsurf', '-m', 'glm-5.2', '-q', testCase.prompt] };
    case 'resume':
      if (!resumeSession) return { missingDependency: 'resume_session_required' };
      return { executable: 'windsurflean', args: ['--resume', resumeSession, '-z', testCase.prompt] };
    default:
      return { executable: 'windsurflean', args: ['chat', '-q', testCase.prompt] };
  }
}

function commandString(spec) {
  if (spec.missingDependency) return `<missing:${spec.missingDependency}>`;
  const renderedArgs = spec.args.map((arg) => /^[A-Za-z0-9_./:=,-]+$/.test(arg) ? arg : shellQuote(arg));
  return [spec.executable, ...renderedArgs].join(' ');
}

function logLineCount(logPath) {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, 'utf8').split(/\r?\n/).length;
}

function writeLogSlice(logPath, startLine) {
  if (!existsSync(logPath)) return logPath;
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
  const slice = lines.slice(Math.max(0, startLine)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'hermes-devin-live-log-'));
  const out = join(dir, 'case.log');
  writeFileSync(out, slice);
  return out;
}

function extractSessionId(output) {
  const explicit = output.match(/Session:\s*([0-9]{8}_[0-9]{6}_[A-Za-z0-9]+)/)?.[1];
  if (explicit) return explicit;
  return output.match(/--resume\s+([0-9]{8}_[0-9]{6}_[A-Za-z0-9]+)/)?.[1] || null;
}

function runCommand(testCase, opts = {}) {
  const spec = commandSpecFor(testCase, opts);
  if (spec.missingDependency) {
    return {
      status: 1,
      signal: null,
      duration_ms: 0,
      output: '',
      output_tail: '',
      matched_expected: false,
      session_id: null,
      failure_code: spec.missingDependency,
    };
  }
  const startedAt = Date.now();
  const result = spawnSync(spec.executable, spec.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    status: result.status,
    signal: result.signal,
    duration_ms: Date.now() - startedAt,
    output,
    output_tail: output.split(/\r?\n/).slice(-36).join('\n'),
    matched_expected: testCase.expected_output.test(output),
    session_id: extractSessionId(output),
    failure_code: null,
  };
}

function runLogCheck(logPath, tailLines, requireToolResult) {
  if (!existsSync(logPath)) return { status: 1, report: null, stdout: '', stderr: `log file not found: ${logPath}` };
  const args = ['scripts/hermes-devin-verify-matrix.mjs', '--check-log', logPath, '--tail-lines', String(tailLines)];
  if (requireToolResult) args.push('--require-tool-result');
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch {}
  return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
}

function publicCase(testCase) {
  return {
    id: testCase.id,
    group: testCase.group,
    mode: testCase.mode,
    prompt: testCase.prompt,
    require_tool_result: testCase.require_tool_result,
    evidence_type: testCase.evidence_type,
    description: testCase.description,
  };
}

function dependencyFailures(selected, opts) {
  const failures = [];
  const hasResume = selected.some((testCase) => testCase.mode === 'resume');
  const hasProducer = selected.some((testCase) => testCase.mode !== 'resume');
  if (hasResume && !opts.resumeSession && !hasProducer) {
    failures.push({ code: 'resume_session_required', message: 'resume_session_smoke requires --resume-session or a prior selected case that captures a session.' });
  }
  return failures;
}

function classifyCase(testCase, run, logCheck) {
  if (run.failure_code) return run.failure_code;
  if (run.status !== 0) return 'command_failed';
  if (!run.matched_expected) return 'expected_output_missing';
  if (testCase.require_tool_result && logCheck.status !== 0) return 'log_check_failed';
  return null;
}

function main() {
  if (hasFlag('--help')) {
    process.stdout.write(usage());
    return 0;
  }
  if (hasFlag('--print-cases')) {
    process.stdout.write(`${JSON.stringify(CASES.map(publicCase), null, 2)}\n`);
    return 0;
  }

  const { selected, failures } = selectCases();
  const opts = {
    profile: value('--profile', DEFAULT_PROFILE),
    resumeSession: value('--resume-session', null),
  };
  failures.push(...dependencyFailures(selected, opts));
  const logPath = value('--log', DEFAULT_LOG);
  const tailLines = Number(value('--tail-lines', '100')) || 100;
  const commands = selected.map((testCase) => {
    const spec = commandSpecFor(testCase, opts);
    return { id: testCase.id, mode: testCase.mode, command: commandString(spec) };
  });

  if (failures.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, failures, selected_cases: selected.map((testCase) => testCase.id), commands }, null, 2)}\n`);
    return 1;
  }

  if (hasFlag('--dry-run')) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dry_run: true,
      profile: opts.profile,
      selected_cases: selected.map((testCase) => testCase.id),
      commands,
    }, null, 2)}\n`);
    return 0;
  }

  const caseReports = [];
  const liveFailures = [];
  let capturedSession = opts.resumeSession;
  for (const testCase of selected) {
    const effectiveOpts = { ...opts, resumeSession: capturedSession };
    const spec = commandSpecFor(testCase, effectiveOpts);
    const command = commandString(spec);
    const logStartLine = logLineCount(logPath);
    const run = runCommand(testCase, effectiveOpts);
    if (run.session_id && !capturedSession) capturedSession = run.session_id;
    const slicedLogPath = writeLogSlice(logPath, logStartLine);
    const logCheck = testCase.require_tool_result
      ? runLogCheck(slicedLogPath, tailLines, true)
      : { status: 0, report: { ok: true, summary: null, failures: [] }, stdout: '', stderr: '' };
    const failureCode = classifyCase(testCase, run, logCheck);
    const ok = !failureCode;
    if (!ok) {
      liveFailures.push({
        code: failureCode,
        case: testCase.id,
        command_status: run.status,
        matched_expected: run.matched_expected,
        log_check_status: logCheck.status,
        log_failures: logCheck.report?.failures || [],
      });
    }
    caseReports.push({
      id: testCase.id,
      mode: testCase.mode,
      evidence_type: testCase.evidence_type,
      command,
      ok,
      classification: ok ? 'proven' : failureCode,
      command_status: run.status,
      duration_ms: run.duration_ms,
      matched_expected: run.matched_expected,
      session_id: run.session_id,
      log_check: logCheck.report,
      output_tail: run.output_tail,
    });
  }

  const report = {
    ok: liveFailures.length === 0,
    profile: opts.profile,
    log: logPath,
    tail_lines: tailLines,
    captured_session: capturedSession,
    selected_cases: selected.map((testCase) => testCase.id),
    cases: caseReports,
    failures: liveFailures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

process.exitCode = main();
