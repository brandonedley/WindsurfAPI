# Upstream Merge: adopt devin-connect (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge `origin/master` (`365bbe0`, 71 commits ahead) into `feat/getchatmessage-tools` (`46061d2`) to adopt upstream's `devin-connect` subsystem, live catalog, and security batch — Phase 1 (safe adoptions) only, then STOP for user review before reconciling `chat.js`/`auth.js`.

**Architecture:** MERGE (not rebase — rebase re-triggers the chat.js/auth.js conflict up to 7×). The two transports (`src/getchatmessage.js` ours, `src/devin-connect.js` theirs) speak the same wire protocol under different filenames, so upstream's new files land side-by-side with zero conflict. Real conflicts = 9 files (verified via `git merge-tree --write-tree origin/master HEAD` on 2026-07-06); only 2 are HIGH (`chat.js`, `auth.js`) and those get a `--ours` placeholder in Phase 1, reconciled in Phase 2 after review. All work happens in an isolated worktree because the live pm2 proxy (`windsurf-api`, obie's lane) runs from the main working tree.

**Tech Stack:** Node 24 `node --test` (upstream), bun+TS dev tooling (ours — union survives), zero runtime deps.

---

## Context you must not re-derive (from the 2026-07-06 port audit)

- **Verified conflict list (merge-tree dry run):** `.gitignore`, `package.json`, `src/auth.js` (HIGH, Phase 2), `src/backend-router.js` (MED), `src/dashboard/api.js` (LOW), `src/handlers/chat.js` (HIGH, Phase 2), `test/_research/responses-cache-hit-seq-A.json`, `test/_research/responses-cache-hit-seq-B.json`, `test/backend-router.test.js`. Everything else auto-merges — including `tool-emulation.js`, `intent-extractor.js`, and `models.js`, so the upstream security batch and stream fixes land for free.
- **Our side of every Phase 1 conflict is tiny** (6-46 lines, exact hunks embedded in the tasks below). Uniform rule: take upstream, re-apply our hunks on top.
- **Transport decision (already made):** adopt upstream `devin-connect` as primary eventually (relogin SPOF fix / failover / liveness / wall-clock deadline / live catalog); keep our pacer (`src/quota-window.js` — upstream never touched it, no conflict); keep `test/fixtures/getchatmessage/*.bin` as the regression corpus to byte-verify the encoders agree before ever retiring `getchatmessage.js`; keep `src/hermes-devin/*`.
- **`test/_research/*.json`:** nothing in test/ or src/ consumes them (verified by grep). Take THEIRS; our committed regeneration (589a720) stays in history.
- **MUST-PORT commits (sanity-check they landed after merge):** security `d4dadf2 e9f8085 22fb534 e75d689 8bd38c7 7320754 1f68752`; transport reliability `59164f3 bb9a273 8c40123 e279fe9`; catalog `c0585d2 052131b 0604f0c`. Plus new since the audit: `d4c7259` (catalog sync retry), `0c77824/4905209/baa8524` (tool-emulation stream fixes), `ea32403` (v2.0.147).
- **SKIP (do not adopt behavior even if it merges):** `0ecf623` text-emulation tool-calling changes are upstream's business — they auto-merge; do not build on them. ACP hardening: leave as merged, unused.
- **Worktree location:** `~/dev/worktrees/WindsurfAPI-upstream-merge` — OUTSIDE `/home/brandon/dev/windsurf` (the vault repo auto-commits via cron and has no gitignore for sibling dirs).
- **Live-tree cautions:** do NOT restart pm2 `windsurf-api`; do NOT commit the user's WIP in the live tree (`test/_research/*.json` mods, `test/dashboard-api.test.js`, `test/messages.test.js` — the latter holds a deliberate red TDD test).

---

## Phase 1 — safe adoptions (this plan)

### Task 1: Commit this plan doc on the branch (docs-only)

**Files:**
- Create: `docs/plans/2026-07-06-upstream-merge-devin-connect.md` (this file)

**Step 1:** In the LIVE tree (`/home/brandon/dev/windsurf/WindsurfAPI`), stage ONLY the plan file:

```bash
git add docs/plans/2026-07-06-upstream-merge-devin-connect.md
git commit -m "docs(plans): upstream merge plan — devin-connect Phase 1"
```

Expected: 1 file changed. `git status` must still show the user's WIP untouched.

### Task 2: Create the isolated worktree

**Step 1:**

```bash
mkdir -p ~/dev/worktrees
cd /home/brandon/dev/windsurf/WindsurfAPI
git worktree add ~/dev/worktrees/WindsurfAPI-upstream-merge -b merge/upstream-2026-07-06 feat/getchatmessage-tools
```

**Step 2:** Verify isolation: `git -C ~/dev/worktrees/WindsurfAPI-upstream-merge status` → clean, branch `merge/upstream-2026-07-06`. The live tree keeps `feat/getchatmessage-tools` checked out and pm2 undisturbed.

**Step 3:** Baseline test run in the worktree BEFORE merging (records the pre-merge green state; the `NODE_TEST_CONTEXT` temp-dir redirect in `src/config.js` keeps `~/.windsurf/accounts.json` safe — this is the fixed account-wipe bug, do not run tests without it):

```bash
cd ~/dev/worktrees/WindsurfAPI-upstream-merge && npm test 2>&1 | tail -5
```

Expected: same pass count as the live tree's committed state (1405+/green; the 1 known red lives only in the live tree's uncommitted WIP, so the worktree should be fully green). Record the number.

### Task 3: Start the merge

**Step 1:**

```bash
cd ~/dev/worktrees/WindsurfAPI-upstream-merge
git merge origin/master
```

Expected: "CONFLICT" in exactly the 9 files listed in Context. If NEW conflict files appear beyond those 9, STOP and re-audit before resolving anything.

**Step 2:** Inventory: `git status --short | grep -E '^(UU|AA)'` and `git diff --name-only --diff-filter=U`.

### Task 4: Resolve the trivial conflicts (`.gitignore`, `package.json`, `test/_research/*.json`)

**`.gitignore`** — union. Take upstream's version, then re-add our 6 lines:

```
!scripts/devin-session-token-probe.mjs
!scripts/devin-cloud-acp-handshake-smoke.mjs
!scripts/sync-hermes-devin-ts.mjs
!scripts/hermes-devin-verify-matrix.mjs
!scripts/hermes-devin-live-smoke.mjs
```
(in the `scripts/*` allowlist block) and `.test-data/` (in the artifacts block).

**`package.json`** — union. Take upstream's version, then re-add our additions: `dev:bun`, `test:bun`, `test:compat`, `typecheck`, `sync:hermes-devin-ts`, `verify:hermes-devin`, `matrix:hermes-devin`, `smoke:hermes-devin`, `smoke:hermes-devin:basic`, `smoke:hermes-devin:full` scripts, and the `devDependencies` block (`@types/node`, `bun-types`). Keep upstream's keywords as-is (they own `zero-dependency`'s fate post-jimp-removal). Keep upstream's `version`.

**`test/_research/responses-cache-hit-seq-A.json` / `-B.json`** — take theirs:

```bash
git checkout --theirs test/_research/responses-cache-hit-seq-A.json test/_research/responses-cache-hit-seq-B.json
git add test/_research/
```

**Step: verify** `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` → no error.

### Task 5: Resolve `src/backend-router.js` + `test/backend-router.test.js` (enum union)

Take upstream's file as the base (it adds `DEVIN_CONNECT` and its selector logic), then re-apply our GETCHATMESSAGE additions — this is the ONE semantic decision in Phase 1:

1. Add to the `BACKEND` enum: `GETCHATMESSAGE: 'getchatmessage-native',` (with our comment block).
2. Re-add our two gate helpers `getChatMessageToolsEnabled(env)` / `getChatMessageAllEnabled(env)` verbatim (they read `WINDSURFAPI_GETCHATMESSAGE_TOOLS` / `WINDSURFAPI_GETCHATMESSAGE_ALL`).
3. Re-add our early-return block at the TOP of `selectBackend` (GETCHATMESSAGE wins over everything including DEVIN_ONLY and any new DEVIN_CONNECT routing — our flag is explicit opt-in and it is the transport obie runs on TODAY). Keep upstream's added params/logic below it. Our block, verbatim:

```js
  if (getChatMessageToolsEnabled(env)
    && modelSupportsTools
    && ((Array.isArray(tools) && tools.length > 0) || getChatMessageAllEnabled(env))
    && modelInfo?.modelUid && !isSpecialAgentInfo(modelInfo)) {
    return {
      backend: BACKEND.GETCHATMESSAGE,
      reason: (Array.isArray(tools) && tools.length > 0) ? 'getchatmessage_tools_flag' : 'getchatmessage_all_flag',
      flow: 'getchatmessage',
    };
  }
```

4. Ensure `selectBackend`'s signature keeps our `tools`/`modelSupportsTools` params merged with whatever upstream added.
5. `test/backend-router.test.js`: union — upstream's new tests + our GETCHATMESSAGE routing tests both survive.

**Verify:** `node --import ./test/setup-env.mjs --test test/backend-router.test.js` → all pass.

### Task 6: Resolve `src/dashboard/api.js` (take upstream + our 8 lines)

Take upstream's version, then re-add:
1. Import: `import { getQuotaWindowSummary } from '../quota-window.js';` (with the stats import block).
2. Route (in `handleDashboardApi`, near the drought route):

```js
  // ─── Quota windows (per-model message-cap governor) ────
  if (subpath === '/quota-windows' && method === 'GET') {
    return json(res, 200, getQuotaWindowSummary());
  }
```

**Verify:** `node --check src/dashboard/api.js`.

### Task 7: Placeholder-resolve `src/handlers/chat.js` + `src/auth.js` (OURS — Phase 2 gate)

```bash
git checkout --ours src/handlers/chat.js src/auth.js
git add src/handlers/chat.js src/auth.js
```

Rationale: our chat.js carries the pacer wiring (`awaitSendSlot`, ~line 1890) and the native GetChatMessage dispatch obie depends on; our auth.js carries the `.bak` self-heal. Upstream's new modules (`devin-connect*.js`, `gemini.js`, `vendor/*`) land side-by-side and are inert until chat.js imports them — that wiring IS Phase 2. Do not hand-merge these two files in Phase 1.

### Task 8: Commit the merge checkpoint

**Step 1:** `git status` → no unmerged paths.
**Step 2:** Commit with an explicit Phase-2 marker:

```bash
git commit -m "merge: origin/master (365bbe0) into feat/getchatmessage-tools — Phase 1

Safe adoptions only. chat.js + auth.js resolved as OURS (placeholder):
upstream's devin-connect dispatch + auth pool rewrite are Phase 2,
gated on user review. backend-router/dashboard-api/package.json/.gitignore
resolved as upstream + our hunks re-applied. test/_research fixtures: theirs."
```

### Task 9: Post-merge verification

**Step 1:** Full suite:

```bash
npm test 2>&1 | tail -15
```

Triage rule: a failure is Phase-1-actionable ONLY if it's in a file we resolved (backend-router, dashboard-api, package/env plumbing) or in OUR subsystems (getchatmessage, quota-window, hermes-devin). Failures in upstream tests that exercise upstream's chat.js/auth.js features (devin-connect dispatch, auth pool) are EXPECTED red under the OURS placeholder — list them, don't fix them; they define Phase 2's acceptance tests.

**Step 2:** Encoder regression corpus intact: `ls test/fixtures/getchatmessage/*.bin` and `node --import ./test/setup-env.mjs --test test/getchatmessage-*.test.js` → green.

**Step 3:** Boot smoke in the worktree WITHOUT touching pm2 (different port, temp data dir):

```bash
PORT=3103 DATA_DIR=$(mktemp -d) timeout 8 node src/index.js 2>&1 | head -20
```

Expected: clean boot banner, no import errors (proves upstream's new files + our placeholder chat.js coexist).

**Step 4:** MUST-PORT sanity: `git log --oneline HEAD --grep 'catalog' | head` and `git show HEAD --stat -- src/devin-connect.js src/devin-connect-models.js src/devin-connect-catalog.js src/gemini.js vendor/ | head -20` → files present.

**Step 5:** Fix anything Phase-1-actionable (TDD: failing test first if writing new code), commit fixes individually.

### Task 10: STOP — report for user review

Deliver: merge commit SHA, test tally (green vs expected-red list), the Phase 2 worklist (chat.js dispatch reconciliation keeping our pacer hook; auth.js = upstream pool + our `.bak` self-heal re-applied), and the open decisions (pro-tier fallback slot; wiring `swe-1.6` via `resolveConnectSelector`/`FREE_TIER_SELECTOR`). Do NOT push, do NOT touch pm2, do NOT start Phase 2 without an explicit go.

---

## Phase 2 preview (gated — not this plan)

Resolution order from the audit: `auth.js` (take upstream pool, re-apply our `7c83874` `.bak` self-heal on top) → `chat.js` (take upstream dispatch seam, re-wire our pacer `awaitSendSlot` + GetChatMessage routing into it) → byte-verify `devin-connect.js` encoder vs ours against `test/fixtures/getchatmessage/*.bin` before any thought of retiring `getchatmessage.js` → re-point the pacer at the new dispatch seam → live cutover (single pm2 restart, obie off windsurf provider first).
