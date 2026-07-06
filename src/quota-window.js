/**
 * Quota governor — client-side model of the upstream ACCOUNT message rate
 * limit.
 *
 * Reconciling the proxy logs against the Hermes gateway's timestamped session
 * logs, then a multi-day sweep of ~/.windsurf/logs/app-*.jsonl, settled the
 * shape of this limiter (2026-07-03):
 *
 *   - It is ACCOUNT-level, not per-model. In every episode all models — glm-5.2,
 *     kimi-k2-6, gpt-5.5, claude — counted down to the SAME unlock instant. One
 *     shared budget for the whole account.
 *   - The window is a fixed ~3 HOURS. Across 37 lockout episodes, 36 fresh marks
 *     were "Resets in: 3h0m0s"; in one episode 54 responses over 71 min all
 *     converged on a single unlock instant within an 18s spread — the server
 *     owns a fixed 3h reset clock and decrements it. Shorter observed values
 *     ("51m", "27m") are countdown TAILS, not separate short penalties. (An
 *     earlier "~1h" read was the tail of one lock mistaken for its onset.)
 *   - Hammering during a lockout does NOT extend it — the unlock instant is
 *     fixed at onset, so retries are benign.
 *
 * The server never reports the cap via any status API — confirmed exhaustively:
 * CheckUserMessageRateLimit.maxMessages returns -1, GetUserStatus JSON carries
 * only daily/weekly CREDIT-quota percentages, and the LS-native GetUserStatus
 * field 35 max_num_premium_chat_messages returns 0 for this tier. So the only
 * way to respect it is to count our own upstream sends per ACCOUNT (across all
 * models) and refuse locally — clean 429 + Retry-After, which agent clients
 * follow into their fallback provider — BEFORE the hard 3h lockout.
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

/** Default window length the upstream limiter uses — measured at ~3h across 37
 * lockout episodes (36/37 fresh marks were "Resets in: 3h0m0s"; in one episode
 * 54 responses over 71 min converged on a single unlock instant within 18s, so
 * the server owns a fixed 3h reset clock). An earlier "~1h" reading was the
 * tail of one lock mistaken for its onset. Override with
 * WINDSURFAPI_QUOTA_WINDOW_HOURS while the exact value is still being pinned. */
export const QUOTA_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Effective window length, honouring the WINDSURFAPI_QUOTA_WINDOW_HOURS
 * override so we can retune without a recompile. */
function windowMs(env = process.env) {
  const h = parseFloat(env.WINDSURFAPI_QUOTA_WINDOW_HOURS || '');
  return Number.isFinite(h) && h > 0 ? Math.round(h * 60 * 60 * 1000) : QUOTA_WINDOW_MS;
}

/** Cap assumed before any lockout has been observed for an account. The
 * account locked around ~100 proxy-visible account-wide sends in the wild. */
export const ACCOUNT_CAP_DEFAULT = 100;

/** Never learn a cap from a window with fewer sends than this. The account key
 * is shared with the devin CLI, so a lockout after a handful of local sends
 * means something OUTSIDE the proxy burned the window — a garbage cap. */
const MIN_LEARN_COUNT = 10;

/** Keep the last N learned caps; capEstimate = min(learnedCaps). */
const LEARNED_CAP_RING = 5;

/** Rolling window for the per-minute RATE guard. The upstream limit may be
 * enforced as a rate (a burst past ~60/min triggers a 1-3h lockout), which the
 * cumulative window budget cannot catch — a subagent fan-out can leap from
 * "safe" to "locked" between two budget checks. This guard throttles when
 * proxy-visible sends approach the per-minute cap. NOTE: the proxy sees only
 * obie's share of the account; the devin CLI's direct sends are invisible, so
 * this cannot prevent a CLI-driven breach — set the cap with headroom. */
const RATE_WINDOW_MS = 60 * 1000;

// windows: { "<acctPrefix>": { accountId, windowStart, windowEnd, count,
//            byModel: {model: n}, learnedCaps: [], lockouts, _milestones: {} } }
let _windows = Object.create(null);

// Interval-pacer scheduler (Option A): per account, the earliest time the next
// send may fire. Each caller claims the next slot and advances it by 60000/RPM.
let _nextSlot = Object.create(null);

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

/** Per-minute send cap for the rate guard / pacer. 0 (unset) disables it. */
function ratePerMin(env = process.env) {
  const n = parseInt(env.WINDSURFAPI_QUOTA_RATE_PER_MIN || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The interval pacer (Option A) smooths sends to <= RATE_PER_MIN by making
 * callers WAIT for their slot instead of 429ing — a single account then serves
 * obie's fan-out without tripping the burst lockout. Default OFF (byte-identical
 * passthrough), independent of the volume governor. */
function pacerEnabled(env = process.env) {
  return String(env.WINDSURFAPI_QUOTA_PACER || '').trim() === '1';
}

/** Beyond this queued wait the pacer rejects instead of holding the request, so
 * a pathologically deep queue falls back (429) rather than blowing the caller's
 * timeout. Default 120s — well under obie's 600s child timeout. */
function pacerMaxWaitMs(env = process.env) {
  const n = parseInt(env.WINDSURFAPI_QUOTA_PACER_MAX_WAIT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/**
 * Substrings that mark a model as STANDARD (low-priority): it is refused at the
 * WINDSURFAPI_QUOTA_SOFT_PCT threshold. Everything else is PRIORITY and may use
 * the shared account budget all the way to the hard learned cap. Default covers
 * obie's cheap workhorse lanes — glm-5* (primary), kimi* (fallback), swe* — so
 * that a flood of those does not preemptively starve the higher-value models
 * (gpt-5.5, claude, ...) out of the soft→hard tail the account still has.
 *
 * This is NOT a separate quota: the message-rate limit is one account-wide
 * bucket (proven across 37 lockout episodes — all models unlocked together), so
 * priority only reallocates the soft→hard band; it never raises the real cap.
 */
const DEFAULT_STANDARD_MODELS = ['glm-5', 'kimi', 'swe'];

function standardModelMarkers(env = process.env) {
  const raw = String(env.WINDSURFAPI_QUOTA_STANDARD_MODELS || '').trim();
  if (!raw) return DEFAULT_STANDARD_MODELS;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** A model is PRIORITY unless its key matches a standard marker. An unknown or
 * undefined model is treated as standard — the stricter, safer default, which
 * also keeps every existing model-agnostic caller on the soft cap. */
function isPriorityModel(modelKey, env = process.env) {
  if (!modelKey) return false;
  const key = String(modelKey).toLowerCase();
  return !standardModelMarkers(env).some(m => key.includes(m));
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
    windowEnd: now + windowMs(),
    count: 0,
    byModel: Object.create(null),
    recentSends: [],
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
  // Rolling per-minute send log for the rate guard (prune then append).
  w.recentSends = (w.recentSends || []).filter(t => t > now - RATE_WINDOW_MS);
  w.recentSends.push(now);
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
    w.windowStart = Math.min(w.windowStart, w.windowEnd - windowMs());
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
 * is near its message cap? The limit is account-wide (one shared bucket), but
 * the BUDGET threshold is priority-aware: standard models (glm-5*, kimi*, swe*)
 * are refused at the soft percent, while priority models keep going to the hard
 * learned cap — reserving the conservative soft→hard tail for higher-value
 * traffic. The RATE guard stays model-agnostic: a burst is dangerous regardless
 * of which model sends it. Pass the requested modelKey to opt into the priority
 * split; omit it and every model is treated as standard (back-compat).
 *
 * Approximation for a multi-account pool: limited iff EVERY tracked live
 * account window is at or over the threshold. With a single-account pool
 * (the current deployment) this is exact. An account that has never sent has
 * no window and keeps the pool open.
 *
 * @returns {{limited: boolean, retryAfterMs?: number, reason?: string}}
 */
export function shouldSoftLimitAccount(now = Date.now(), env = process.env, modelKey) {
  if (!governorEnabled(env)) return { limited: false };
  const pct = softPct(env);
  const rateCap = ratePerMin(env);
  const priority = isPriorityModel(modelKey, env);
  let sawLive = false;
  let budgetEnd = 0;   // latest window end among budget-exhausted accounts
  let rateRetry = 0;   // shortest rate-drain among rate-breached accounts
  for (const w of Object.values(_windows)) {
    if (now > w.windowEnd) continue; // expired → fresh budget on next send
    sawLive = true;

    // RATE guard (rolling 60s): a burst throttles with a SHORT retry (until the
    // window drains), independent of the cumulative window budget.
    let rateBreached = false;
    if (rateCap > 0) {
      const recent = (w.recentSends || []).filter(t => t > now - RATE_WINDOW_MS);
      if (recent.length >= rateCap) {
        rateBreached = true;
        const drain = Math.min(...recent) + RATE_WINDOW_MS - now;
        rateRetry = rateRetry ? Math.min(rateRetry, drain) : drain;
      }
    }

    const cap = capFor(w, env);
    // Priority models get the whole account budget (refused only at the hard
    // cap); standard models refuse at the soft percent, ceding the tail.
    const budgetThreshold = priority ? cap : Math.ceil((cap * pct) / 100);
    const budgetExhausted = w.count >= budgetThreshold;

    // This account can take the send only if it is under BOTH guards.
    if (!rateBreached && !budgetExhausted) return { limited: false };
    if (budgetExhausted) budgetEnd = Math.max(budgetEnd, w.windowEnd);
  }
  if (!sawLive) return { limited: false };

  // No account is available. Return the SHORT rate-drain retry when the block
  // is (also) a rate breach; otherwise the longer budget-window retry.
  if (rateRetry > 0) {
    const retry = budgetEnd > now ? Math.min(rateRetry, budgetEnd - now) : rateRetry;
    return { limited: true, retryAfterMs: Math.max(1000, retry), reason: 'rate' };
  }
  return { limited: true, retryAfterMs: Math.max(1000, budgetEnd - now), reason: 'budget' };
}

/** Per-account snapshot for the dashboard (/quota-windows) and logs. */
export function getQuotaWindowSummary(now = Date.now()) {
  return Object.values(_windows).map(w => {
    const cap = capFor(w);
    return {
      accountId: w.accountId,
      count: w.count,
      sendsLastMin: (w.recentSends || []).filter(t => t > now - RATE_WINDOW_MS).length,
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
const _defaultSleep = (ms) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  if (t.unref) t.unref();
});

/**
 * Interval pacer (Option A). Await this before an upstream send: it holds the
 * request until its scheduled slot (>= 60000/RPM after the previous send on the
 * same account), smoothing bursts to <= RATE_PER_MIN so a single account never
 * trips the burst lockout. The slot claim is SYNCHRONOUS (no await before
 * _nextSlot is advanced), so concurrent callers get distinct sequential slots
 * with no thundering herd. Returns { waitedMs } once the slot is due, or
 * { rejected, retryAfterMs } if the wait would exceed the max — the caller then
 * 429s and lets the agent fall back. No-op ({ waitedMs: 0 }) unless
 * WINDSURFAPI_QUOTA_PACER=1 and a positive RATE_PER_MIN are set. `now`/`sleep`
 * are injectable for deterministic tests.
 */
export async function awaitSendSlot(accountId, { now = Date.now(), env = process.env, sleep = _defaultSleep } = {}) {
  if (!pacerEnabled(env)) return { waitedMs: 0 };
  const rpm = ratePerMin(env);
  if (rpm <= 0) return { waitedMs: 0 };
  const k = acctPrefix(accountId);
  const intervalMs = Math.ceil(RATE_WINDOW_MS / rpm);
  const slot = Math.max(now, _nextSlot[k] || 0);
  const wait = slot - now;
  if (wait > pacerMaxWaitMs(env)) {
    // Do NOT claim the slot — a rejected send must not advance the scheduler.
    return { rejected: true, retryAfterMs: wait };
  }
  _nextSlot[k] = slot + intervalMs;
  if (wait > 0) await sleep(wait);
  return { waitedMs: wait };
}

export function _resetForTests() {
  _windows = Object.create(null);
  _nextSlot = Object.create(null);
  clearTimeout(_saveTimer);
}
