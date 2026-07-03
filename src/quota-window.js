/**
 * Quota governor — client-side model of the upstream ACCOUNT message rate
 * limit.
 *
 * Reconciling the proxy logs against the Hermes gateway's timestamped session
 * logs settled the shape of this limiter (2026-07-03):
 *
 *   - It is ACCOUNT-level, not per-model. Every model's lockout — glm-5.2 and
 *     kimi-k2-6 alike — counted down to the SAME unlock instant (09:28:37),
 *     across seven separate events. One shared budget for the whole account.
 *   - The window is ~1 HOUR, not 3. The account hit its cap at 08:28:37 and
 *     unlocked exactly 3600s later; the server's own trailer said "Resets in:
 *     51m24s" at 08:37. (The "Resets in: 3h0m0s" trailers are a looser,
 *     usually non-binding per-model counter.)
 *   - Hammering during a lockout does NOT extend it — the unlock instant is
 *     fixed at onset, so retries are benign.
 *
 * The server never reports this limit via any status API (getUserStatus covers
 * only the daily/weekly CREDIT quota, handled separately in auth.js), so the
 * only way to respect it is to count our own upstream sends per ACCOUNT (across
 * all models) and refuse locally — clean 429 + Retry-After, which agent clients
 * follow into their fallback provider — BEFORE the hard 1h lockout.
 *
 * The previous per-(account,model) design learned a garbage cap for kimi-k2-6
 * (22, the count kimi happened to have when an ACCOUNT-level lock landed) and
 * then soft-limited kimi for hours per window — starving obie's fallback lane.
 * Counting per-account fixes that: there is no per-model window to starve.
 *
 * The devin CLI shares the account key and its sends never reach this proxy, so
 * our per-account count UNDER-estimates true account usage. Learning the cap
 * from where lockouts actually land (proxy-visible count at the cliff) and
 * thresholding off the MOST CONSERVATIVE (min) learned cap self-tunes around
 * that hidden burn.
 *
 * Flag-gated: WINDSURFAPI_QUOTA_GOVERNOR=1 enables the soft-limit decision
 * (default OFF). Counting/learning always runs — cheap, and having caps already
 * learned makes the flag effective the moment it is flipped.
 * Tunables: WINDSURFAPI_QUOTA_SOFT_PCT (default 85, percent of the cap),
 * WINDSURFAPI_QUOTA_ACCOUNT_CAP (default 100, the cap used until one is learned).
 *
 * Persistence mirrors dashboard/stats.js: debounced atomic JSON in
 * config.dataDir (quota-windows.json), best-effort load on import.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from './fs-atomic.js';
import { config, log } from './config.js';

const QUOTA_FILE = join(config.dataDir, 'quota-windows.json');

/** Fixed window length the upstream limiter uses — measured at ~1h (the
 * account locked and unlocked exactly 3600s later; trailer "Resets in 51m24s").
 */
export const QUOTA_WINDOW_MS = 60 * 60 * 1000;

/** Cap assumed before any lockout has been observed for an account. The
 * account locked around ~100 proxy-visible account-wide sends in the wild. */
export const ACCOUNT_CAP_DEFAULT = 100;

/** Never learn a cap from a window with fewer sends than this. The account key
 * is shared with the devin CLI, so a lockout after a handful of local sends
 * means something OUTSIDE the proxy burned the window — a garbage cap. */
const MIN_LEARN_COUNT = 10;

/** Keep the last N learned caps; capEstimate = min(learnedCaps). */
const LEARNED_CAP_RING = 5;

// windows: { "<acctPrefix>": { accountId, windowStart, windowEnd, count,
//            byModel: {model: n}, learnedCaps: [], lockouts, _milestones: {} } }
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

function accountCapDefault(env = process.env) {
  const n = parseInt(env.WINDSURFAPI_QUOTA_ACCOUNT_CAP || '', 10);
  return Number.isFinite(n) && n > 0 ? n : ACCOUNT_CAP_DEFAULT;
}

/** Same short-prefix convention dashboard/stats.js uses for account keys —
 * never persist a full api key. */
function acctPrefix(accountId) {
  return String(accountId || 'unknown').slice(0, 8);
}

function freshWindow(accountId, now) {
  return {
    accountId: acctPrefix(accountId),
    windowStart: now,
    windowEnd: now + QUOTA_WINDOW_MS,
    count: 0,
    byModel: Object.create(null),
    learnedCaps: [],
    lockouts: 0,
    _milestones: {},
  };
}

function rollIfExpired(w, accountId, now) {
  if (now <= w.windowEnd) return w;
  const rolled = freshWindow(accountId, now);
  rolled.learnedCaps = w.learnedCaps; // caps persist across windows
  rolled.lockouts = w.lockouts;
  return rolled;
}

/** Conservative (min) of the learned caps, or the configured default if none
 * has been learned for this account yet. */
function capFor(w, env = process.env) {
  return w.learnedCaps.length ? Math.min(...w.learnedCaps) : accountCapDefault(env);
}

/**
 * Count one request that actually reaches upstream on this account. Call it per
 * upstream ATTEMPT (a failed call may still consume a message — overcounting is
 * the safe direction for a limiter). modelKey is recorded only for the
 * per-model display breakdown; it does not affect the account budget.
 */
export function recordUpstreamSend(accountId, modelKey, now = Date.now()) {
  const k = acctPrefix(accountId);
  let w = _windows[k] || freshWindow(accountId, now);
  w = rollIfExpired(w, accountId, now);
  w.count++;
  if (modelKey) w.byModel[modelKey] = (w.byModel[modelKey] || 0) + 1;
  _windows[k] = w;

  // Log once per window when account usage crosses 50/80/100% of the cap so
  // "is the account about to get locked out?" is visible before the trailer.
  const cap = capFor(w);
  if (cap) {
    for (const pct of [50, 80, 100]) {
      if (!w._milestones[pct] && w.count >= Math.ceil((cap * pct) / 100)) {
        w._milestones[pct] = true;
        log.warn(`QuotaWindow: account ${w.accountId} at ${w.count}/${cap} (${pct}% of cap) — window resets in ${Math.max(0, Math.round((w.windowEnd - now) / 60000))}m`);
      }
    }
  }
  scheduleSave();
}

/**
 * A real upstream lockout landed on this account. Anchor the window end to the
 * server's own reset clock and (when the local count is credible) learn the
 * account cap from where the cliff actually was. modelKey is accepted for
 * call-site symmetry with recordUpstreamSend but does not scope anything — the
 * lockout is account-wide.
 */
export function onRateLimitLockout(accountId, modelKey, retryAfterMs, now = Date.now()) {
  const k = acctPrefix(accountId);
  const w = _windows[k] || freshWindow(accountId, now);
  w.lockouts++;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    w.windowEnd = now + retryAfterMs;
    w.windowStart = Math.min(w.windowStart, w.windowEnd - QUOTA_WINDOW_MS);
  }
  if (w.count >= MIN_LEARN_COUNT) {
    w.learnedCaps.push(w.count);
    if (w.learnedCaps.length > LEARNED_CAP_RING) w.learnedCaps.shift();
    log.info(`QuotaWindow: learned account cap for ${w.accountId}: ${w.count} msgs/window (estimates: [${w.learnedCaps.join(', ')}])`);
  }
  _windows[k] = w;
  scheduleSave();
}

/**
 * Should upstream sends be refused locally right now because the account pool
 * is near its 1h message cap? Model-agnostic — the limit is account-wide.
 *
 * Approximation for a multi-account pool: limited iff EVERY tracked live
 * account window is at or over the soft threshold. With a single-account pool
 * (the current deployment) this is exact. An account that has never sent has
 * no window and keeps the pool open.
 *
 * @returns {{limited: boolean, retryAfterMs?: number}}
 */
export function shouldSoftLimitAccount(now = Date.now(), env = process.env) {
  if (!governorEnabled(env)) return { limited: false };
  const pct = softPct(env);
  let sawLive = false;
  let latestEnd = 0;
  for (const w of Object.values(_windows)) {
    if (now > w.windowEnd) continue; // expired → fresh budget on next send
    sawLive = true;
    const cap = capFor(w, env);
    if (w.count < Math.ceil((cap * pct) / 100)) return { limited: false };
    latestEnd = Math.max(latestEnd, w.windowEnd);
  }
  if (!sawLive) return { limited: false };
  return { limited: true, retryAfterMs: Math.max(1000, latestEnd - now) };
}

/** Per-account snapshot for the dashboard (/quota-windows) and logs. */
export function getQuotaWindowSummary(now = Date.now()) {
  return Object.values(_windows).map(w => {
    const cap = capFor(w);
    return {
      accountId: w.accountId,
      count: w.count,
      byModel: { ...w.byModel },
      capEstimate: cap,
      capSource: w.learnedCaps.length ? 'learned' : 'default',
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
