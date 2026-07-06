#!/usr/bin/env node
/**
 * DEVIN_CONNECT image-field tag calibration harness.
 *
 * The `images` field nests inside each ChatMessage, but its protobuf tag number
 * is UNKNOWN — the live capture was text-only and the prost binary embeds no
 * descriptor (see memory: devin-connect-tools-vision-2026-06-30). This harness
 * probes candidate tags by sending a tiny test image under each one against a
 * VISION-CAPABLE model and classifying the upstream reaction:
 *
 *   - A wrong tag collides with another field → decode/"internal" error, or the
 *     image is silently ignored (model says it sees no image).
 *   - The RIGHT tag → the model acknowledges the image content (it sees "red").
 *
 * This CANNOT run on a free account: swe-1.6 is not a vision model. It needs a
 * paid/vision entitlement (e.g. claude-opus-4.8, gemini-3-flash). It is BILLABLE
 * and OFF by default — set IMAGE_CALIBRATE_REAL=1 to actually fire. Without it
 * the script runs an offline self-test (mocked transport) so the classification
 * + sweep wiring is proven correct NOW, on no token / no network / no billing;
 * only the real firing waits for a paid credential.
 *
 * Usage (real):
 *   IMAGE_CALIBRATE_REAL=1 \
 *   CONNECT_SMOKE_TOKEN=<paid-token> \
 *   IMAGE_CALIBRATE_MODEL=claude-opus-4.8 \
 *   IMAGE_CALIBRATE_TAGS=4,5,6,10,11 \
 *   node scripts/devin-connect-image-calibrate.mjs
 *
 * Self-test (no token, no network, always safe):
 *   node scripts/devin-connect-image-calibrate.mjs        # IMAGE_CALIBRATE_REAL unset
 *
 * The harness sets DEVIN_CONNECT_IMAGE_TAG per-probe (process.env) so the
 * builder in src/devin-connect.js emits the ImageData under that tag, then
 * inspects the answer. On a HIT it persists the calibrated tag to
 * devin-connect-image-tag.json (gitignored, same as accounts.json) and prints
 * the DEVIN_CONNECT_IMAGE_TAG=<n> line for the operator.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as connect from '../src/devin-connect.js';
import { resolveConnectSelector } from '../src/devin-connect-models.js';

const REAL = process.env.IMAGE_CALIBRATE_REAL === '1';
const TIMEOUT_MS = Number(process.env.IMAGE_CALIBRATE_TIMEOUT_MS || 60000);
const DEFAULT_MODEL = process.env.IMAGE_CALIBRATE_MODEL || 'claude-opus-4.8';

// A 1x1 red PNG — smallest valid image, enough to ask "what color is this?".
const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Evidence-ordered candidate tags, narrowed from the reverse-engineering in
 * .workflow-results/devin-protobuf/P2-apiserver-methods-fields.md §2.2:
 *   - ChatMessageInner declared field order is
 *     `message_id, role, images, tool_call_id, ..., content, thinking` and a
 *     second binary variant orders it `message_id, role, content, images, ...`.
 *   - `content` is verified LIVE at tag #3. Declaration order ≠ tag number, but
 *     the variant that puts `images` immediately after `content` makes #4 the
 *     single strongest candidate, with #5–#7 the close neighbours.
 *   - #1/#2/#3 are taken (message_id/role/content), so they're excluded — #3 in
 *     particular is confirmed `content`, probing it would just collide.
 * This is a narrowed PRIORITY, not a hard-coded answer: override with
 * IMAGE_CALIBRATE_TAGS to widen.
 */
export const DEFAULT_TAGS = [4, 5, 6, 7];

const visionPrompt = [
  { type: 'text', text: 'What single color fills this image? Answer with just the color word.' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT_PNG}` } },
];

export function resolveToken(env = process.env) {
  if (env.CONNECT_SMOKE_TOKEN) return env.CONNECT_SMOKE_TOKEN.trim();
  for (const k of ['DEVIN_CONNECT_TOKEN', 'DEVIN_SESSION_TOKEN', 'WINDSURF_SESSION_TOKEN']) {
    if (env[k]) return env[k].trim();
  }
  try {
    // Path overridable so tests can prove the no-token guard without the repo's
    // real accounts.json shadowing it; defaults to the sibling accounts.json.
    const accountsUrl = env.IMAGE_CALIBRATE_ACCOUNTS_FILE
      ? new URL(`file://${env.IMAGE_CALIBRATE_ACCOUNTS_FILE.replace(/\\/g, '/')}`)
      : new URL('../accounts.json', import.meta.url);
    const accounts = JSON.parse(readFileSync(accountsUrl, 'utf8'));
    const first = accounts.find((a) => a.apiKey);
    if (first) return first.apiKey;
  } catch {}
  return '';
}

/** Default landing spot for the calibrated tag. Gitignored like accounts.json.
 *  Overridable via env so tests can write to a temp file. */
export function resolveResultPath(env = process.env) {
  return env.DEVIN_CONNECT_IMAGE_TAG_OUT
    || fileURLToPath(new URL('../devin-connect-image-tag.json', import.meta.url));
}

export function parseTags(raw, fallback = DEFAULT_TAGS) {
  if (!raw) return [...fallback];
  const tags = String(raw)
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return tags.length ? tags : [...fallback];
}

/**
 * Classify one probe outcome into a stable bucket. Pure + exported so the
 * self-test can assert it without a network.
 *   - 'calibrated' → 200, content mentions the image's colour ("red"): the model
 *                    DEMONSTRABLY saw the image, so this tag is the right one.
 *   - 'miss'       → 200 with content but no colour match: the tag was accepted
 *                    on the wire but the image was silently ignored (wrong field).
 *   - 'error'      → upstream rejected it (decode/"internal" error from a tag
 *                    collision, UNAUTHORIZED, rate limit, timeout) or empty body.
 */
export function classifyProbe({ content, error }) {
  if (error) {
    const code = error.code || 'ERR';
    return { bucket: 'error', sawImage: false, detail: `${code}: ${String(error.message || '').slice(0, 60)}` };
  }
  const text = (content || '').trim();
  if (!text) return { bucket: 'error', sawImage: false, detail: 'empty content' };
  const sawImage = /\bred\b/i.test(text);
  return sawImage
    ? { bucket: 'calibrated', sawImage: true, detail: text.slice(0, 60) }
    : { bucket: 'miss', sawImage: false, detail: text.slice(0, 60) };
}

/**
 * Run the full tag sweep. `deps` is injectable for the self-test: { chat }.
 * Returns { modelAlive, hit, selector, tags, rows, verdict, resultPath, wrote }.
 *
 * Liveness/baseline disambiguation: a wrong image tag can collide with another
 * field and surface as a generic upstream "internal error" — indistinguishable
 * in isolation from the model or token simply being broken. So BEFORE the sweep
 * we fire one TEXT-ONLY probe (no image) at the same vision model. If it returns
 * content the model+token are provably usable, so any per-tag `error` is about
 * the TAG (a collision), not the transport; and a `miss` is a genuine
 * image-ignored result. If the text baseline itself fails, the whole run is moot
 * and the per-tag rows mean nothing.
 */
export async function runSweep({
  token,
  model = DEFAULT_MODEL,
  tags = DEFAULT_TAGS,
  deps = {},
  real = REAL,
  writeResult = false,
  resultPath = null,
  env = process.env,
} = {}) {
  const _chat = deps.chat || connect.chat;
  const resolved = resolveConnectSelector(model);
  const selector = typeof resolved === 'string' ? resolved : resolved?.selector || model;
  const outPath = resultPath || resolveResultPath(env);

  // Text-only baseline (no image) — see the doc comment above.
  let modelAlive = null; // null = not determined (dry run)
  if (real) {
    try {
      const r = await _chat({
        token, model: selector,
        messages: [{ role: 'user', content: 'reply with exactly: ALIVE' }],
        maxTokens: 8, timeoutMs: TIMEOUT_MS,
      });
      modelAlive = Boolean(r.content && r.content.trim());
    } catch {
      modelAlive = false;
    }
  }

  const rows = [];
  let hit = null;
  for (const tag of tags) {
    if (!real) {
      rows.push({ tag, bucket: 'skipped', sawImage: false, detail: 'IMAGE_CALIBRATE_REAL!=1 (dry run)' });
      continue;
    }
    let outcome;
    const prev = env.DEVIN_CONNECT_IMAGE_TAG;
    env.DEVIN_CONNECT_IMAGE_TAG = String(tag);
    try {
      const r = await _chat({
        token, model: selector,
        messages: [{ role: 'user', content: visionPrompt }],
        maxTokens: 16, timeoutMs: TIMEOUT_MS,
      });
      outcome = classifyProbe({ content: r.content });
    } catch (error) {
      outcome = classifyProbe({ error });
    } finally {
      if (prev === undefined) delete env.DEVIN_CONNECT_IMAGE_TAG;
      else env.DEVIN_CONNECT_IMAGE_TAG = prev;
    }
    rows.push({ tag, ...outcome });
    if (outcome.bucket === 'calibrated') { hit = tag; break; } // found it, stop burning billable calls
  }

  let verdict;
  if (!real) verdict = 'dry-run (no probes fired)';
  else if (modelAlive === false) verdict = 'model/token UNUSABLE — text-only baseline failed; per-tag results are meaningless (re-check the model is vision-capable and the token is alive)';
  else if (hit != null) verdict = `CALIBRATED — images field tag = ${hit}`;
  else verdict = `no candidate tag made the model see the image (${tags.join(',')}); widen IMAGE_CALIBRATE_TAGS or MITM a real vision turn`;

  let wrote = false;
  if (real && hit != null && writeResult) {
    const payload = {
      tag: hit,
      env: `DEVIN_CONNECT_IMAGE_TAG=${hit}`,
      model,
      selector,
      answer: rows.find((r) => r.tag === hit)?.detail || '',
      calibratedAt: new Date().toISOString(),
    };
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    wrote = true;
  }

  return { modelAlive, hit, selector, tags, rows, verdict, resultPath: outPath, wrote };
}

// ─── Offline self-test: proves classifyProbe + runSweep wiring with a mocked
// transport, so the harness is verified correct before any paid token exists.
async function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error(`[SELFTEST FAIL] ${msg}`); process.exitCode = 1; } };

  // 1) classifyProbe buckets
  assert(classifyProbe({ content: 'red' }).bucket === 'calibrated', 'red → calibrated');
  assert(classifyProbe({ content: 'This is a RED square.' }).bucket === 'calibrated', 'word boundary red → calibrated');
  assert(classifyProbe({ content: 'I see no image.' }).bucket === 'miss', 'no colour → miss');
  assert(classifyProbe({ content: '   ' }).bucket === 'error', 'empty content → error');
  assert(classifyProbe({ error: { code: 'UNAUTHORIZED', message: 'x' } }).bucket === 'error', 'UNAUTHORIZED → error');
  assert(classifyProbe({ error: { code: 'ERR', message: 'decode failed' } }).bucket === 'error', 'decode err → error');

  // A tag-aware fake transport: it reads the per-probe DEVIN_CONNECT_IMAGE_TAG
  // exactly like the real builder does, so this also proves the env wiring. The
  // text-only baseline (no image content) returns ALIVE.
  const makeChat = (rightTag) => async ({ messages }) => {
    const content = messages[0].content;
    const hasImage = Array.isArray(content) && content.some((p) => p.type === 'image_url');
    if (!hasImage) return { content: 'ALIVE' }; // baseline
    const tag = Number(process.env.DEVIN_CONNECT_IMAGE_TAG);
    if (tag === rightTag) return { content: 'red' };          // the model sees it
    if (tag === 6) throw { code: 'ERR', message: 'decode error: field collision' }; // a collision tag
    return { content: 'I cannot see any image.' };            // accepted but ignored
  };

  // 2) a tag in the sweep is the right one → calibrated, sweep stops, file persisted
  const tmp = fileURLToPath(new URL(`../tmp-selftest-image-tag-${process.pid}.json`, import.meta.url));
  const hitRun = await runSweep({
    token: 'fake', real: true, tags: [4, 5, 6, 7], model: 'claude-opus-4.8',
    writeResult: true, resultPath: tmp,
    deps: { chat: makeChat(5) },
  });
  assert(hitRun.modelAlive === true, 'baseline proved model usable');
  assert(hitRun.hit === 5, `hit tag 5 (got ${hitRun.hit})`);
  assert(hitRun.rows.find((r) => r.tag === 4)?.bucket === 'miss', 'tag 4 ignored → miss');
  assert(hitRun.rows.find((r) => r.tag === 5)?.bucket === 'calibrated', 'tag 5 → calibrated');
  assert(!hitRun.rows.some((r) => r.tag === 7), 'sweep stopped after the hit (7 not probed)');
  assert(/CALIBRATED/.test(hitRun.verdict), 'verdict CALIBRATED');
  try {
    const persisted = JSON.parse(readFileSync(tmp, 'utf8'));
    assert(persisted.tag === 5 && persisted.env === 'DEVIN_CONNECT_IMAGE_TAG=5', 'persisted tag 5');
  } catch (e) {
    assert(false, `result file readable: ${e.message}`);
  } finally {
    try { (await import('fs')).rmSync(tmp, { force: true }); } catch {}
  }

  // 3) no tag matches → no hit, file NOT written
  const missRun = await runSweep({
    token: 'fake', real: true, tags: [4, 7], model: 'claude-opus-4.8',
    writeResult: true, resultPath: tmp,
    deps: { chat: makeChat(99) },
  });
  assert(missRun.hit === null, 'no hit when no tag matches');
  assert(missRun.wrote === false, 'nothing persisted on a miss');
  assert(missRun.rows.every((r) => r.bucket === 'miss'), 'all miss');
  assert(/no candidate tag/.test(missRun.verdict), 'verdict reports no match');

  // 4) text baseline fails → run is moot, all tag rows meaningless, no write
  const deadRun = await runSweep({
    token: 'fake', real: true, tags: [4, 5], model: 'claude-opus-4.8',
    writeResult: true, resultPath: tmp,
    deps: { chat: async () => { throw { code: 'UNAUTHORIZED', message: 'dead' }; } },
  });
  assert(deadRun.modelAlive === false, 'baseline failed → modelAlive false');
  assert(deadRun.hit === null && deadRun.wrote === false, 'dead run writes nothing');
  assert(/UNUSABLE/.test(deadRun.verdict), 'dead run verdict flags UNUSABLE');

  if (process.exitCode) console.error('\n[SELFTEST] FAILED — do not trust the harness until fixed.');
  else console.log('[SELFTEST] OK — classify + sweep + persistence wiring verified (no token, no network, no billing).');
}

// ─── Main ────────────────────────────────────────────────────────────────────
// Guarded so importing this module (the test harness does) doesn't run the CLI
// or call process.exit — only direct `node scripts/...` invocation executes below.
async function main() {
  const model = DEFAULT_MODEL;
  const tags = parseTags(process.env.IMAGE_CALIBRATE_TAGS);
  const token = resolveToken();
  const { selector } = (() => {
    const r = resolveConnectSelector(model);
    return typeof r === 'string' ? { selector: r } : (r || { selector: model });
  })();

  console.log(`[image-calibrate] model=${model} selector=${selector} tags=[${tags.join(',')}] real=${REAL}`);

  if (!REAL) {
    console.log('IMAGE_CALIBRATE_REAL is not 1 — running offline self-test only (no token, no network, no billing).');
    console.log('Note: free swe-1.6 is NOT a vision model — real calibration requires a paid/vision entitlement.');
    console.log('To calibrate: IMAGE_CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<paid-token> IMAGE_CALIBRATE_MODEL=claude-opus-4.8 node scripts/devin-connect-image-calibrate.mjs\n');
    await selfTest();
    process.exit(process.exitCode || 0);
  }

  if (!token) {
    console.error('IMAGE_CALIBRATE_REAL=1 but no token — set CONNECT_SMOKE_TOKEN or persist a paid account.');
    console.error('Note: free swe-1.6 is NOT a vision model — calibration requires a paid/vision entitlement.');
    process.exit(2);
  }

  console.log(`[image-calibrate] firing real billable probes (timeout ${TIMEOUT_MS}ms each)\n`);
  const result = await runSweep({ token, model, tags, real: true, writeResult: true });

  for (const r of result.rows) {
    const label = r.bucket === 'calibrated' ? 'HIT (model saw the image!)'
      : r.bucket === 'miss' ? 'accepted but image ignored'
        : `rejected (${r.detail})`;
    console.log(`  tag=${String(r.tag).padStart(3)} → ${label}  "${r.detail}"`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`VERDICT: ${result.verdict}`);
  if (result.hit != null) {
    console.log(`\nDEVIN_CONNECT_IMAGE_TAG=${result.hit}`);
    console.log(`Set that in production and record it to memory. Wrote ${result.resultPath}`);
  } else {
    console.log('Widen IMAGE_CALIBRATE_TAGS, confirm the model is vision-capable, or MITM a real');
    console.log('vision turn from devin.exe to read the tag directly.');
  }
  process.exit(result.hit != null ? 0 : 1);
}

const isEntry = import.meta.main
  ?? (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href);
if (isEntry) await main();
