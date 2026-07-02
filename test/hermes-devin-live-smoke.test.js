import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = 'scripts/hermes-devin-live-smoke.mjs';

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: '.test-data' },
  });
}

describe('Hermes Devin live smoke matrix runner', () => {
  it('prints the canonical live cases as JSON', () => {
    const result = run(['--print-cases']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cases = JSON.parse(result.stdout);
    const ids = cases.map((testCase) => testCase.id);
    for (const id of [
      'plain_chat',
      'terminal_pwd',
      'read_file_package',
      'search_files_package',
      'multi_turn_terminal_followup',
      'stateful_tool_boundary',
      'web_search_smoke',
      'full_tool_hermes_smoke',
      'resume_session_smoke',
    ]) {
      assert.ok(ids.includes(id), `missing case ${id}`);
    }
    assert.ok(cases.every((testCase) => typeof testCase.prompt === 'string' && testCase.prompt.length > 0));
    assert.ok(cases.every((testCase) => ['none', 'direct_or_recovery', 'boundary', 'resume'].includes(testCase.evidence_type)));
  });

  it('dry-runs selected cases without invoking the provider', () => {
    const result = run(['--dry-run', '--case', 'terminal_pwd', '--case', 'read_file_package']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.dry_run, true);
    assert.deepEqual(report.selected_cases, ['terminal_pwd', 'read_file_package']);
    assert.ok(report.commands.every((item) => item.command.includes('windsurflean chat -q')));
  });

  it('dry-runs per-case command modes with the expected command shapes', () => {
    const result = run([
      '--dry-run',
      '--case', 'terminal_pwd',
      '--case', 'full_tool_hermes_smoke',
      '--case', 'resume_session_smoke',
      '--resume-session', '20260101_000000_deadbe',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const byCase = Object.fromEntries(report.commands.map((item) => [item.id, item.command]));
    assert.match(byCase.terminal_pwd, /^windsurflean chat -q /);
    assert.match(byCase.full_tool_hermes_smoke, /^hermes chat --provider windsurf -m glm-5\.2 -q /);
    assert.match(byCase.resume_session_smoke, /^windsurflean --resume 20260101_000000_deadbe -z /);
  });

  it('fails dry-run when an unknown case is requested', () => {
    const result = run(['--dry-run', '--case', 'not_a_case']);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0].code, 'unknown_case');
  });

  it('requires an explicit or captured session dependency for resume dry-run', () => {
    const result = run(['--dry-run', '--case', 'resume_session_smoke']);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0].code, 'resume_session_required');
  });
});
