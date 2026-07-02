/**
 * Quota governor — client-side model of the upstream per-account, per-model
 * MESSAGE rate limit.
 *
 * Windsurf enforces two independent limiters. The daily/weekly CREDIT quota is
 * observable via GetUserStatus and already handled (quotaScore / drought mode
 * in auth.js). The per-model MESSAGE cap on a fixed ~3h window is NOT
 * observable — the server only reveals it by refusing you ("Reached message
 * rate limit for this model. Resets in: 3h0m0s"), and hitting it costs the
 * whole remainder of the window for that model. So this module counts our own
 * upstream sends per account+model window, learns each model's cap empirically
 * from where past lockouts landed, and lets the chat handler refuse locally
 * (clean 429 + Retry-After, which agent clients follow into their fallback
 * provider) BEFORE the hard lockout — preserving reserve budget instead of
 * burning the window to the cliff.
 *
 * Flag-gated: WINDSURFAPI_QUOTA_GOVERNOR=1 enables the soft-limit decision
 * (default OFF). Counting/learning always runs — it is cheap, and having caps
 * already learned makes the flag effective the moment it is flipped.
 * Threshold: WINDSURFAPI_QUOTA_SOFT_PCT (default 85, percent of learned cap).
 *
 * Persistence mirrors dashboard/stats.js: debounced atomic JSON in
 * config.dataDir (quota-windows.json), best-effort load on import.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './fs-atomic.js';
import { config, log } from './config.js';

const QUOTA_FILE = join(config.dataDir, 'quota-windows.json');

/** Fixed window length the upstream limiter uses ("Resets in: 3h0m0s"). */
export const QUOTA_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Never learn a cap from a window with fewer sends than this. The account
 * key is shared with external clients (the devin CLI uses the same account),
 * so a lockout after a handful of local sends means something OUTSIDE the
 * proxy burned the window — our local count would be a garbage cap. */
const MIN_LEARN_COUNT = 10;

/** Keep the last N learned caps; capEstimate = max(learnedCaps). */
const LEARNED_CAP_RING = 5;

// windows: { "acctPrefix:modelKey": { accountId, modelKey, windowStart,
//            windowEnd, count, learnedCaps: [], lockouts, _milestones: {} } }
let _windows = Object.create(null);

// Load persisted state (best-effort, shape-checked).
try {
  if (existsSync(QUOTA_FILE)) {
    const saved = JSON.parse(readFileSync(QUOTA_FILE, 'utf-8'));
    if (saved && typeof saved.windows === 'object') _windows = { ...saved.windows };
  }
} catch { /* corrupt state file — start fresh */ }

let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { writeJsonAtomic(QUOTA_FILE, { windows: _windows }); } catch { /* best-effort */ }
  }, 5000);
  // Never hold the process open just to flush counters.
  if (_saveTimer.unref) _saveTimer.unref();
}

function governorEnabled(env = process.env) {
  return String(env.WINDSURFAPI_QUOTA_GOVERNOR || '').trim() === '1';
}

function softPct(env = process.env) {
  const n = parseInt(env.WINDSURFAPI_QUOTA_SOFT_PCT || '', 10);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 85;
}

/** Same short-prefix convention dashboard/stats.js uses for account keys —
 * never persist a full api key. */
function acctPrefix(accountId) {
  return String(accountId || 'unknown').slice(0, 8);
}

function keyFor(accountId, modelKey) {
  return `${acctPrefix(accountId)}:${modelKey}`;
}

function freshWindow(accountId, modelKey, now) {
  return {
    accountId: acctPrefix(accountId),
    modelKey,
    windowStart: now,
    windowEnd: now + QUOTA_WINDOW_MS,
    count: 0,
    learnedCaps: [],
    lockouts: 0,
    _milestones: {},
  };
}

function rollIfExpired(w, accountId, modelKey, now) {
  if (now <= w.windowEnd) return w;
  const rolled = freshWindow(accountId, modelKey, now);
  rolled.learnedCaps = w.learnedCaps;
  rolled.lockouts = w.lockouts;
  return rolled;
}

function capEstimate(w) {
  return w.learnedCaps.length ? Math.max(...w.learnedCaps) : null;
}

/**
 * Count one request that actually reaches upstream for this account+model.
 * Call it per upstream ATTEMPT (a failed call may still consume a message —
 * overcounting is the safe direction for a limiter).
 */
export function recordUpstreamSend(accountId, modelKey, now = Date.now()) {
  if (!modelKey) return;
  const k = keyFor(accountId, modelKey);
  let w = _windows[k] || freshWindow(accountId, modelKey, now);
  w = rollIfExpired(w, accountId, modelKey, now);
  w.count++;
  _windows[k] = w;

  // Log once per window when usage crosses 50/80/100% of the learned cap so
  // "are we about to get locked out?" is visible before the trailer arrives.
  const cap = capEstimate(w);
  if (cap) {
    for (const pct of [50, 80, 100]) {
      if (!w._milestones[pct] && w.count >= Math.ceil((cap * pct) / 100)) {
        w._milestones[pct] = true;
        log.warn(`QuotaWindow: ${modelKey} at ${w.count}/${cap} (${pct}% of learned cap) — window resets in ${Math.max(0, Math.round((w.windowEnd - now) / 60000))}m`);
      }
    }
  }
  scheduleSave();
}

/**
 * A real upstream lockout landed for this account+model. Anchor the window
 * end to the server's own reset clock and (when the local count is credible)
 * learn the cap from where the cliff actually was.
 */
export function onRateLimitLockout(accountId, modelKey, retryAfterMs, now = Date.now()) {
  if (!modelKey) return;
  const k = keyFor(accountId, modelKey);
  const w = _windows[k] || freshWindow(accountId, modelKey, now);
  w.lockouts++;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    w.windowEnd = now + retryAfterMs;
    w.windowStart = Math.min(w.windowStart, w.windowEnd - QUOTA_WINDOW_MS);
  }
  if (w.count >= MIN_LEARN_COUNT) {
    w.learnedCaps.push(w.count);
    if (w.learnedCaps.length > LEARNED_CAP_RING) w.learnedCaps.shift();
    log.info(`QuotaWindow: learned cap for ${modelKey}: ${w.count} msgs/window (estimates: [${w.learnedCaps.join(', ')}])`);
  }
  _windows[k] = w;
  scheduleSave();
}

/**
 * Should a request for this model be refused locally right now?
 *
 * Approximation: limited iff EVERY tracked live window for the model is at or
 * over the soft threshold of its learned cap. With a single-account pool
 * (the current deployment) this is exact. With multiple accounts, an account
 * that has never sent this model has no window and keeps the model open —
 * only fully-burned pools get gated.
 *
 * @returns {{limited: boolean, retryAfterMs?: number}}
 */
export function shouldSoftLimitModel(modelKey, now = Date.now(), env = process.env) {
  if (!governorEnabled(env) || !modelKey) return { limited: false };
  const pct = softPct(env);
  let sawLive = false;
  let latestEnd = 0;
  for (const w of Object.values(_windows)) {
    if (w.modelKey !== modelKey) continue;
    if (now > w.windowEnd) continue; // expired → fresh budget on next send
    const cap = capEstimate(w);
    if (!cap) return { limited: false }; // no cap learned → observe-only
    sawLive = true;
    if (w.count < Math.ceil((cap * pct) / 100)) return { limited: false };
    latestEnd = Math.max(latestEnd, w.windowEnd);
  }
  if (!sawLive) return { limited: false };
  return { limited: true, retryAfterMs: Math.max(1000, latestEnd - now) };
}

/** Per-window snapshot for the dashboard (/quota-windows) and logs. */
export function getQuotaWindowSummary(now = Date.now()) {
  return Object.values(_windows).map(w => {
    const cap = capEstimate(w);
    return {
      accountId: w.accountId,
      modelKey: w.modelKey,
      count: w.count,
      capEstimate: cap,
      percentUsed: cap ? Math.round((w.count / cap) * 100) : null,
      learnedCaps: [...w.learnedCaps],
      lockouts: w.lockouts,
      windowEndsAt: w.windowEnd,
      windowEndsInMs: Math.max(0, w.windowEnd - now),
      live: now <= w.windowEnd,
      governorEnabled: governorEnabled(),
      softPct: softPct(),
    };
  });
}

/** Test hook: reset in-memory state (persistence untouched until next save). */
export function _resetForTests() {
  _windows = Object.create(null);
  clearTimeout(_saveTimer);
}
