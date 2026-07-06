import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classifyProbe, runSweep, parseTags, DEFAULT_TAGS } from '../scripts/devin-connect-image-calibrate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const script = join(root, 'scripts', 'devin-connect-image-calibrate.mjs');

function runScript(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A tag-aware fake transport mirroring the real builder: the text-only baseline
// (no image content) returns ALIVE; an image probe is judged by the per-probe
// DEVIN_CONNECT_IMAGE_TAG env the sweep sets.
const makeChat = (rightTag) => async ({ messages }) => {
  const content = messages[0].content;
  const hasImage = Array.isArray(content) && content.some((p) => p.type === 'image_url');
  if (!hasImage) return { content: 'ALIVE' };
  const tag = Number(process.env.DEVIN_CONNECT_IMAGE_TAG);
  if (tag === rightTag) return { content: 'red' };
  if (tag === 6) throw { code: 'ERR', message: 'decode error: field collision' };
  return { content: 'I see no image.' };
};

describe('devin-connect image-calibrate harness', () => {
  it('runs its offline self-test clean with no token, no network, no billing', async () => {
    const { code, stdout } = await runScript({ IMAGE_CALIBRATE_REAL: '' });
    assert.equal(code, 0, `self-test exit 0\n${stdout}`);
    assert.match(stdout, /SELFTEST\] OK/);
    assert.match(stdout, /no token, no network, no billing/);
  });

  it('refuses to fire real billable probes without a token', async () => {
    const { code, stderr } = await runScript({
      IMAGE_CALIBRATE_REAL: '1',
      CONNECT_SMOKE_TOKEN: '', DEVIN_CONNECT_TOKEN: '', DEVIN_SESSION_TOKEN: '', WINDSURF_SESSION_TOKEN: '',
      IMAGE_CALIBRATE_ACCOUNTS_FILE: join(tmpdir(), 'img-cal-no-such-accounts.json'),
    });
    assert.equal(code, 2, 'no-token guard exits 2');
    assert.match(stderr, /no token/);
  });

  it('defaults DEFAULT_TAGS to the evidence-ordered list led by #4', () => {
    assert.deepEqual(DEFAULT_TAGS, [4, 5, 6, 7]);
    assert.equal(DEFAULT_TAGS[0], 4, 'tag #4 is the prioritised candidate');
  });

  it('parseTags falls back to DEFAULT_TAGS but honours an override', () => {
    assert.deepEqual(parseTags(''), DEFAULT_TAGS);
    assert.deepEqual(parseTags('10, 11 ,12'), [10, 11, 12]);
    assert.deepEqual(parseTags('garbage'), DEFAULT_TAGS, 'all-invalid override falls back');
  });

  it('classifyProbe buckets each upstream outcome', () => {
    assert.equal(classifyProbe({ content: 'red' }).bucket, 'calibrated');
    assert.equal(classifyProbe({ content: 'a RED dot' }).bucket, 'calibrated');
    assert.equal(classifyProbe({ content: 'I see no image' }).bucket, 'miss');
    assert.equal(classifyProbe({ content: '   ' }).bucket, 'error');
    assert.equal(classifyProbe({ error: { code: 'UNAUTHORIZED', message: 'x' } }).bucket, 'error');
    assert.equal(classifyProbe({ error: { code: 'ERR', message: 'decode' } }).bucket, 'error');
  });

  it('calibrates on the right tag, stops the sweep, and persists to the override path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-cal-'));
    const out = join(dir, 'tag.json');
    try {
      const r = await runSweep({
        token: 'fake', real: true, tags: [4, 5, 6, 7], model: 'claude-opus-4.8',
        writeResult: true, resultPath: out,
        deps: { chat: makeChat(5) },
      });
      assert.equal(r.modelAlive, true, 'text baseline proved model usable');
      assert.equal(r.hit, 5);
      assert.equal(r.rows.find((x) => x.tag === 4).bucket, 'miss', 'tag 4 image ignored → miss');
      assert.equal(r.rows.find((x) => x.tag === 5).bucket, 'calibrated');
      assert.ok(!r.rows.some((x) => x.tag === 7), 'sweep stopped after the hit (7 not probed)');
      assert.match(r.verdict, /CALIBRATED/);
      assert.equal(r.wrote, true);
      assert.ok(existsSync(out), 'result file written to override path');
      const persisted = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(persisted.tag, 5);
      assert.equal(persisted.env, 'DEVIN_CONNECT_IMAGE_TAG=5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies an accepted-but-ignored image as miss and writes nothing on no hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-cal-'));
    const out = join(dir, 'tag.json');
    try {
      const r = await runSweep({
        token: 'fake', real: true, tags: [4, 7], model: 'claude-opus-4.8',
        writeResult: true, resultPath: out,
        deps: { chat: makeChat(99) },
      });
      assert.equal(r.hit, null);
      assert.ok(r.rows.every((x) => x.bucket === 'miss'));
      assert.equal(r.wrote, false, 'no persistence on a miss');
      assert.ok(!existsSync(out), 'no file written when no tag calibrates');
      assert.match(r.verdict, /no candidate tag/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buckets a tag collision as error while a usable baseline still flows', async () => {
    const r = await runSweep({
      token: 'fake', real: true, tags: [6, 5], model: 'claude-opus-4.8',
      deps: { chat: makeChat(5) },
    });
    assert.equal(r.modelAlive, true);
    assert.equal(r.rows.find((x) => x.tag === 6).bucket, 'error', 'collision tag → error, not miss');
    assert.equal(r.hit, 5);
  });

  it('flags the run UNUSABLE and writes nothing when the text baseline fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-cal-'));
    const out = join(dir, 'tag.json');
    try {
      const r = await runSweep({
        token: 'fake', real: true, tags: [4, 5], model: 'claude-opus-4.8',
        writeResult: true, resultPath: out,
        deps: { chat: async () => { throw { code: 'UNAUTHORIZED', message: 'dead' }; } },
      });
      assert.equal(r.modelAlive, false);
      assert.equal(r.hit, null);
      assert.equal(r.wrote, false);
      assert.ok(!existsSync(out));
      assert.match(r.verdict, /UNUSABLE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
