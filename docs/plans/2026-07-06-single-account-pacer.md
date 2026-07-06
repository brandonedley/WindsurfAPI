# Single-Account Rate Pacer (Option A)

Date: 2026-07-06
Status: DONE + verified live (2026-07-06)

## Result

Pacer built TDD (`src/quota-window.js` `awaitSendSlot`, 6 tests), wired into the
native send in `src/handlers/chat.js`, flags in `.env` (PACER=1, RATE_PER_MIN=8),
obie fan-out trimmed (3->2 / 3->2). Live burst test: 5 simultaneous glm-5.2
requests serialized at exactly 7494/14993/22493/29992ms holds (60000/8 interval),
all HTTP 200, **0 × 429, 0 × governor, 0 × queue-full**. quota-window 34/34,
getchatmessage-routing 28/28 green.

## Problem

obie's `delegation` block fans out up to 6 subagents (`claude-sonnet-5`, 3 sync + 3
async, ≤50 iters each) onto a **single** Windsurf account. That bursts far past
WindsurfAPI's documented `RPM < 10 per account`, tripping the 5-minute ban detector
and the ~3h account window. A prior "quota governor" mis-learned a phantom volume
cap (62) from one such burst and self-429'd every request at 53/window — disabled
2026-07-06.

## Key finding (authoritative, GetUserStatus 2026-07-06)

The account is **NOT volume-limited**: `planName: Pro`, `dailyPercent: 100`,
`weeklyPercent: 99`, `prompt.limit: -0.01` (unmetered). Premium models
(glm-5.2, claude-opus-4-8) probe `ok`. The only real constraint is the
**per-minute rate** (`RPM < 10`). So the fix is to smooth the rate, not cap volume.

## Design — interval pacer, WAIT semantics (not reject)

Reject-on-breach (a 429) makes obie fall off Windsurf to the deepseek fallback and
loses the lane. Instead, **queue**: requests wait for their slot, then proceed.

Per-account interval scheduler in `src/quota-window.js`:

- `nextSlotAt[account]`: earliest time the next send may fire.
- On send: `slot = max(now, nextSlotAt); nextSlotAt = slot + (60000 / RPM); wait = slot - now`.
- If `wait > maxWaitMs` → reject (429 fallback, last resort only when queue is
  pathologically deep). Else `await sleep(wait)` then proceed.
- Spacing at RPM=8 → one send every 7.5s, serialized, no thundering herd.
- Per-account isolation; injectable `sleep` + `now` for tests.

New export: `async awaitSendSlot(accountId, { now, env, sleep })
  → { waitedMs } | { rejected: true, retryAfterMs }`.

Config (env):
- `WINDSURFAPI_QUOTA_PACER=1` — enable the pacer (default off = byte-identical).
- `WINDSURFAPI_QUOTA_RATE_PER_MIN=8` — target RPM (docs: <10).
- `WINDSURFAPI_QUOTA_PACER_MAX_WAIT_MS=120000` — reject beyond this (< child 600s).

The phantom **volume** governor (`WINDSURFAPI_QUOTA_GOVERNOR`) stays **off**.

## Wiring

In `src/handlers/chat.js`, before the **native** GetChatMessage send (right after
`nativeAcct` is acquired, ~line 1890): `await awaitSendSlot(nativeAcct.apiKey)`.
On `rejected`, return the existing 429 shape. `recordUpstreamSend` stays for stats.

Scope: native route only. Under `GETCHATMESSAGE_ALL=1` + `GETCHATMESSAGE_TOOLS=1`
all of obie's traffic takes the native path (its own comment: "carries the bulk of
agent traffic"). The legacy Cascade path has multiple retry send-sites and is
bypassed in this deployment, so it is intentionally not paced.

## obie config (`~/.hermes/config.yaml`)

- `delegation.max_concurrent_children: 3 → 2`
- `delegation.max_async_children: 3 → 2`
- keep `delegation.provider: windsurf` (the cheap premium lane).

## Verify

- TDD: interval spacing, per-account isolation, max-wait rejection, disabled passthrough.
- Live: fire a burst of N>8 requests, confirm they serialize ~7.5s apart, all 200,
  zero real upstream 429s over a window.

## Not doing

Second account (user constraint). Moving fan-out to Codex (would spend paid tokens
to dodge a rate limit pacing fixes for free, and waste included premium models).
