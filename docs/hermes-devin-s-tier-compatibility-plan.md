# Hermes ↔ WindsurfAPI/Devin S-Tier Compatibility Plan

> For Hermes/Obie: execute this with strict TDD and post-diff review. Do not use live GLM/Windsurf upstream calls for development verification while rate-limited; use unit tests, fixtures, and mocked upstream responses first.

Goal: make WindsurfAPI/Devin a disciplined OpenAI-compatible agent provider for Hermes, not a fragile patched proxy that depends on model-specific prose recovery.

Architecture: introduce a HermesDevin compatibility layer that owns request budgeting, tool classification, native/emulated/denied routing, state-machine transitions, rate-limit fail-fast behavior, and OpenAI-compatible response/error normalization. Existing chat handling, Cascade native bridge, Devin ACP probes, and account routing remain useful, but they become implementation details behind an explicit contract.

Tech stack target: TypeScript-first on Bun. Current repo reality is Node ESM JavaScript with no `tsconfig.json`; live PM2 currently starts `node src/index.js`, so TypeScript files cannot be imported into the live path until the runtime/test harness is migrated. New S-tier compatibility code should move toward `.ts` modules and `bun test`/`bun run` as the execution baseline instead of adding more long-lived JavaScript.

---

## 0. Evidence and constraints

### 0.1 Hermes expects OpenAI-compatible providers

Hermes custom endpoints are expected to implement `/v1/chat/completions`; the provider docs explicitly say any server implementing that endpoint can be configured as a custom provider. Source: Hermes provider docs, `Custom & Self-Hosted LLM Providers`, https://hermes-agent.nousresearch.com/docs/integrations/providers#custom--self-hosted-llm-providers.

Hermes' local chat transport treats messages and tools as OpenAI format: `/home/brandon/.hermes/hermes-agent.canary/agent/transports/chat_completions.py:1-9` says this transport handles OpenAI-compatible providers, and `convert_tools()` is identity at `/home/brandon/.hermes/hermes-agent.canary/agent/transports/chat_completions.py:219-221`.

Hermes has a central error taxonomy with `rate_limit`, `context_overflow`, and `payload_too_large` categories at `/home/brandon/.hermes/hermes-agent.canary/agent/error_classifier.py:24-45`; rate-limit patterns include `rate limit`, `too many requests`, `try again in`, and `please retry after` at `/home/brandon/.hermes/hermes-agent.canary/agent/error_classifier.py:117-134`.

Hermes tool surface is large. The tools reference lists persistent/session/system tools like `memory`, `todo`, `cronjob`, `session_search`, `clarify`, plus execution tools such as `terminal`, `process`, file tools, delegation, browser, web, media, messaging, and skills. Source: Hermes tools reference, https://hermes-agent.nousresearch.com/docs/reference/tools-reference.

OpenAI's function-calling flow is app → model with tool definitions, model → app with structured tool call, app executes, app sends tool output, model returns final answer. Source: OpenAI function calling docs, https://platform.openai.com/docs/guides/function-calling. OpenAI also recommends limiting the initial tool set, aiming for fewer than 20 functions at the start of a turn. Same source.

### 0.2 WindsurfAPI has existing pieces, but no clean compatibility boundary yet

The chat route currently decides native vs emulated tools in `buildToolRoutingPlan()` at `/home/brandon/dev/windsurf/WindsurfAPI/src/handlers/chat.js:133-155`. It sets `nativeBridgeOn`, partitions tools, and uses all unmapped tools for emulation.

The current allowlist guard drops parser-produced tool calls not declared by the request at `/home/brandon/dev/windsurf/WindsurfAPI/src/handlers/chat.js:181-210`. That is necessary but not sufficient: a declared Hermes tool like `memory` can still be unsafe to fabricate.

The native bridge already documents the correct high-level translation concept: OpenAI-shaped client tools ↔ Cascade native step kinds. See `/home/brandon/dev/windsurf/WindsurfAPI/src/cascade-native-bridge.js:1-48`. It also says mixed mapped/unmapped requests currently fall back to emulation rather than split native coverage, at `/home/brandon/dev/windsurf/WindsurfAPI/src/cascade-native-bridge.js:34-37`.

The native bridge currently has a concrete map for Claude/Codex/common tools such as `Read`, `Bash`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, `view_file`, `run_command`, `read_file`, and `shell`. See `/home/brandon/dev/windsurf/WindsurfAPI/src/cascade-native-bridge.js:451-508`.

The native bridge is intentionally default-off and narrow: only command tools are default allowlisted, and docs warn not to enable for local IDE agents unless remote Windsurf workspace execution is intended. See `/home/brandon/dev/windsurf/WindsurfAPI/src/cascade-native-bridge.js:83-90` and `/home/brandon/dev/windsurf/WindsurfAPI/src/cascade-native-bridge.js:46-48`.

### 0.3 Devin/ACP is the real future backend, not just Cascade prompt emulation

The repo already has Devin cloud ACP research and code. `buildDevinCloudAcpUrl()` builds `wss://.../api/acp/live?token=...` with host rewrite and token stripping at `/home/brandon/dev/windsurf/WindsurfAPI/src/devin-cloud-acp.js:19-37`.

`buildInitializeRequest()` emits JSON-RPC `initialize` with client info and capabilities at `/home/brandon/dev/windsurf/WindsurfAPI/src/devin-cloud-acp.js:45-63`.

The Devin reverse-engineering doc says the target should be a narrow, gated backend behind the existing OpenAI-compatible route, not a production enablement free-for-all: `/home/brandon/dev/windsurf/WindsurfAPI/docs/devin-api-reverse-engineering.md:5-13`.

That doc identifies two upstream surfaces: Windsurf/Codeium Connect-RPC for account/model status and Devin cloud API/ACP for remote agent sessions. See `/home/brandon/dev/windsurf/WindsurfAPI/docs/devin-api-reverse-engineering.md:61-75`.

Devin Desktop's canonical cloud ACP flow is: resolve session token, build websocket URL, connect, initialize, then `session/new` → `session/prompt`. See `/home/brandon/dev/windsurf/WindsurfAPI/docs/devin-api-reverse-engineering.md:223-232`.

ACP is JSON-RPC-style and stateful. MCP's public spec is not Devin ACP, but it validates the same design bias: stateful connections, capability negotiation, progress/cancellation, and explicit tool safety/consent concerns. Source: MCP 2025-06-18 spec, https://modelcontextprotocol.io/specification/2025-06-18.

### 0.4 Rate-limit handling exists but needs compatibility-level fail-fast

`markRateLimited(apiKey, durationMs, modelKey)` records model-specific cooldown and logs the cooldown duration at `/home/brandon/dev/windsurf/WindsurfAPI/src/auth.js:1051-1070`.

`isAllTemporarilyUnavailable(modelKey)` computes whether every eligible account is unavailable and returns a retry-after duration at `/home/brandon/dev/windsurf/WindsurfAPI/src/auth.js:1252-1297`.

The recent failure showed the missing layer: an unsafe tool recovery fabricated `memory`, caused extra turns, then one upstream rate-limit produced many sticky checks and queue timeout noise. The S-tier fix is to turn these capabilities into a request-level circuit breaker with a clean OpenAI-compatible 429 response.

---

## 1. Compatibility contract

The adapter must expose this contract to Hermes:

1. Endpoint: `/v1/chat/completions` accepts OpenAI-compatible chat messages and `tools` arrays.
2. Tool format: incoming tools are OpenAI function tools. The adapter never mutates caller-visible tool names unless it can reverse-map them losslessly.
3. Streaming: streaming responses must either emit normal assistant content or OpenAI-compatible tool-call deltas. Internal Cascade/ACP events must not leak.
4. Tool result continuation: after Hermes sends tool results, the adapter must continue the same logical Devin/Cascade session or explicitly fail with a typed nonretryable error. It must not re-run the same tool from the original user prompt.
5. Native/emulated/denied routing: every declared Hermes tool is classified before upstream dispatch.
6. No heuristic side effects: narrative/prose recovery may only emit calls for an explicit allowlist of safe local tools. Persistent/external/stateful tools are never fabricated.
7. Context budget: reject or degrade unsafe payloads before upstream calls. Huge prompt + 32 tools must not silently burn account quota.
8. Rate limits: one upstream rate-limit event produces one account/model cooldown and one clean client error if no healthy account exists. No retry storm.
9. Observability: every request logs adapter mode, tool classification, context budget, state transitions, upstream session/reuse id, and final response type.

---

## 2. New modules

### 2.1 `src/hermes-devin/tool-policy.js`

Owns classification of Hermes tools.

Exports:

```js
export const TOOL_MODE = Object.freeze({
  native: 'native',
  emulated: 'emulated',
  denied: 'denied',
});

export function classifyHermesTool(tool, modelPolicy, adapterOptions = {}) {
  // returns { name, mode, reason, cascadeKind?, recoveryAllowed, sideEffectLevel }
}

export function classifyToolInventory(tools, modelPolicy, adapterOptions = {}) {
  // returns { nativeTools, emulatedTools, deniedTools, summaries }
}

export function isRecoveryAllowed(toolName, paramName, recoveryKind) {
  // true only for terminal command extraction and read_file path extraction.
}
```

Initial policy:

Native candidates if bridge explicitly enabled and mapped:
- `Bash`, `shell_command`, `run_command`, `terminal`, `Read`, `read_file`, `Grep`, `Glob`, `WebSearch` depending on proven map and environment mode.

Emulated safe recovery:
- `terminal` / shell-like tools only with concrete command extraction.
- `read_file` / `Read` only with concrete path extraction.

Denied for heuristic recovery:
- `memory`, `skill_manage`, `cronjob`, `send_message`, `clarify`, `delegate_task`, `patch`, `write_file`, browser click/type/navigation, image/video generation, and any tool with persistent/external side effects.

Important: denied for heuristic recovery is not the same as denied for normal model-emitted valid tool calls. A valid OpenAI tool_call for `memory` from a trusted model can still pass if declared and schema-valid. It just cannot be invented by fallback.

### 2.2 `src/hermes-devin/model-policy.js`

Owns model capability registry.

Exports:

```js
export function getHermesDevinModelPolicy(modelKey, provider) {
  return {
    adapterMode,
    preferredDialect,
    maxToolsFull,
    maxPromptCharsWithTools,
    maxRecoveryAttempts,
    allowGenericNarrativeRecovery,
    allowNativeBridge,
    rateLimitRetryPolicy,
  };
}
```

Initial policy examples:

- `glm-*`: degraded compatibility, max recovery attempts 1, no generic fallback, lower tool/context thresholds, no live stress retry.
- `kimi-*`: constrained compatibility, model-specific dialect, no persistent-tool recovery.
- `gpt-*`: GPT-native dialect, schema validation required, normal full-tool mode only after passing certification tests.
- `swe-*` / Devin native: ACP-first path once implemented.

### 2.3 `src/hermes-devin/context-budget.js`

Owns payload size decisions.

Exports:

```js
export function measureCompatRequest({ messages, tools, modelPolicy }) {
  return { messageChars, systemChars, lastUserChars, toolCount, toolSchemaChars, totalApproxChars };
}

export function decideContextBudget(measurement, modelPolicy) {
  return { action: 'allow' | 'degrade' | 'reject', reason, status?, retryable?, details };
}
```

Rules:

- If prompt/tool payload exceeds hard cap, reject before upstream with OpenAI-compatible `413` / `context_length_exceeded` or `payload_too_large` shape.
- If over soft cap, degrade by reducing tool surface to the policy's safe subset and log `CompatBudget: degraded`.
- If huge prompt + broad toolset + fragile model, do not call upstream.

### 2.4 `src/hermes-devin/state-machine.js`

Owns request lifecycle.

States:

- `received`
- `budget_checked`
- `tools_classified`
- `dispatching`
- `streaming`
- `tool_call_emitted`
- `awaiting_tool_result`
- `post_tool_continuation`
- `completed`
- `client_aborted`
- `rate_limited`
- `failed_nonretryable`

Exports:

```js
export function createCompatTrace(requestId, input) { ... }
export function transition(trace, nextState, meta = {}) { ... }
export function summarizeTrace(trace) { ... }
```

This is not ceremony. It is how we prevent hidden loops.

### 2.5 `src/hermes-devin/rate-limit.js`

Owns compatibility-level rate-limit fail-fast.

Exports:

```js
export function parseUpstreamRetryAfter(errorOrMessage) { ... }
export function buildOpenAIRateLimitError({ model, retryAfterMs, accountScope }) { ... }
export function shouldStopAccountRetries({ modelKey, accountPoolStatus, error }) { ... }
```

Behavior:

- Parse reset durations from English and Chinese upstream messages.
- If `isAllTemporarilyUnavailable(modelKey)` is true, return a clean OpenAI 429 immediately.
- Do not spin on sticky checks when no account can satisfy the model.

### 2.6 `src/hermes-devin/adapter.js`

The orchestration layer called from `chat.js`.

Exports:

```js
export function prepareHermesDevinRequest({ messages, tools, modelKey, provider, route, callerKey }) {
  // returns routing plan, budget decision, model policy, trace
}

export function processModelTextForCompat({ text, tools, modelPolicy, trace, hasToolResult }) {
  // returns { text, toolCalls, suppressedReason? }
}

export function normalizeCompatError(err, context) { ... }
```

`chat.js` should call this before `buildToolRoutingPlan()` becomes final. Long-term, `buildToolRoutingPlan()` moves under this adapter or becomes a lower-level primitive.

---

## 3. Test strategy

No live upstream calls for core development. Live calls are certification only.

### 3.1 Unit tests

Create:

- `test/hermes-devin-tool-policy.test.js`
- `test/hermes-devin-context-budget.test.js`
- `test/hermes-devin-rate-limit.test.js`
- `test/hermes-devin-state-machine.test.js`
- `test/hermes-devin-adapter.test.js`

Minimum cases:

1. `memory` is never heuristic-recoverable.
2. `patch` and `write_file` are never heuristic-recoverable.
3. `terminal` is recoverable only with explicit run/execute command text.
4. `read_file` is recoverable only with a concrete path.
5. Huge prompt + 32 tools + `glm-*` returns `degrade` or `reject` before upstream.
6. Huge prompt + persistent tool mention does not produce tool calls.
7. After a tool result exists, user-prompt fallback is off.
8. Same tool + same args already emitted in the same turn is blocked.
9. Upstream rate-limit string with `Resets in: 2h59m43s` yields retry-after milliseconds.
10. Chinese `请 10745 秒后重试` yields retry-after milliseconds.
11. All accounts temporarily unavailable maps to one OpenAI 429 response.
12. Adapter trace records all compatibility decisions.

### 3.2 Golden fixtures

Create `test/fixtures/hermes-devin/`:

- `glm-huge-prompt-memory-fabrication.json`
- `glm-terminal-narrate-only.json`
- `read-file-post-tool-result-loop.json`
- `rate-limit-english-180m.json`
- `rate-limit-chinese-10745s.json`
- `full-32-tool-hermes-request.json` with redacted/minimized schemas.

Fixtures should be synthetic/minimized. Do not store secrets or full private chat logs.

### 3.3 Mock upstream tests

Create a local mock Cascade/Devin upstream for tests only:

- returns narrate-only prose
- returns malformed tool JSON
- returns valid tool call
- returns rate-limit errors
- simulates client disconnect
- simulates post-tool continuation

### 3.4 Live certification

Only after unit + mock green:

1. reduced toolset terminal smoke
2. reduced toolset read_file smoke
3. post-tool continuation smoke
4. full toolset no-op smoke
5. huge prompt guard smoke that must reject/degrade without upstream burn
6. rate-limit simulator, not live rate-limit trigger

Live GLM calls stay disabled during current cooldown.

---

## 4. Implementation tasks

### Task 0: Move the compatibility work to Bun + TypeScript

Objective: establish the runtime/test boundary that lets new compatibility code be written in TypeScript without breaking the existing live Node service.

Evidence from live repo check:
- `bun` is available at `/home/brandon/.local/bin/bun`, version `1.3.0`.
- There is currently no `tsconfig.json` or existing `.ts` source surface in the repo root scan.
- `package.json` still runs `node src/index.js` and `node --test`, so production imports from `.ts` files are not safe until the process manager and scripts move to Bun or a build step exists.
- `bun test test/hermes-devin-tool-policy.test.js` already runs the new compatibility policy test successfully, so the test runner migration is viable.

Files:
- Create: `tsconfig.json`
- Modify: `package.json`
- Modify PM2/ecosystem/runtime config if present
- Eventually rename new compatibility modules/tests from `.js` to `.ts`

TDD / migration checks:
1. Add `tsconfig.json` with strict settings compatible with Bun/Node ESM.
2. Add Bun scripts such as `test:bun`, then switch compatibility tests to `bun test` first.
3. Verify existing JavaScript tests still run under Bun or keep a temporary `test:node` script for legacy files.
4. Convert only the new `src/hermes-devin/*` modules and their tests to TypeScript first.
5. Do not point live PM2 at TypeScript until a local health check proves `bun src/index.ts` or `bun src/index.js` can run the service correctly.
6. Once runtime is proven, make Bun the default for S-tier compatibility tests and development commands.

### Task 1: Lock the regression that caused the rate limit

Objective: guarantee broad user-argument fallback cannot fabricate `memory` or other stateful tools from huge prompts.

Files:
- Modify: `src/handlers/intent-extractor.js`
- Test: `test/v2081-chinese-nlu.test.js`

Steps:
1. Add/keep failing test: huge prompt + `memory` tool + model prose must return `[]`.
2. Run: `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=0 WINDSURFAPI_FORCE_GLM_DIALECT=glm47 node --test --test-force-exit test/v2081-chinese-nlu.test.js`
3. Implement or preserve `isSafeUserArgumentFallbackTool()` allowlist.
4. Re-run focused tests.
5. Run current broader focused set:
   `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=0 WINDSURFAPI_FORCE_GLM_DIALECT=glm47 node --test --test-force-exit test/v2081-chinese-nlu.test.js test/v2079-audit-followup.test.js test/tool-emulation-gpt-native.test.js`

Status: partially implemented in the current working tree. Keep it as baseline and do not widen it.

Post-plan review found two required additions before this task can be considered closed:

- `detectToolIntentInNarrative()` has a side door: if action keywords are present, it can return the first declared tool even when no tool name is present. That path must also be gated by tool policy so stateful tools like `memory` are never nominated for correction retries merely because they appear first in the declared tool list.
- `chat.js` currently sets `emulationTools` to all tools whenever native bridge is off. The future denied-tool policy must eventually filter what reaches the emulation preamble, not only what NLU fallback can recover.

### Task 2: Extract tool-policy module

Objective: move hardcoded safe recovery and side-effect classification out of `intent-extractor.js` into a dedicated compatibility policy module.

Files:
- Create: `src/hermes-devin/tool-policy.js`
- Create: `test/hermes-devin-tool-policy.test.js`
- Modify: `src/handlers/intent-extractor.js`

TDD:
1. Test stateful tools denied for heuristic recovery: memory, skill_manage, cronjob, send_message, patch, write_file.
2. Test terminal/read_file allowed only for their specific recovery kinds.
3. Run test, verify RED because module missing.
4. Implement `TOOL_MODE`, `isRecoveryAllowed()`, `classifyHermesTool()` minimal shape.
5. Wire `intent-extractor.js` to use `isRecoveryAllowed()`.
6. Run tool-policy + v2081 tests.

### Task 3: Add model-policy registry

Objective: centralize model-specific compatibility decisions.

Files:
- Create: `src/hermes-devin/model-policy.js`
- Create: `test/hermes-devin-model-policy.test.js`

TDD cases:
1. `glm-5.2` returns degraded adapter mode, maxRecoveryAttempts=1, no generic narrative recovery.
2. `kimi-*` returns constrained mode.
3. `gpt-*` returns GPT-native dialect preference.
4. unknown model returns conservative default.

### Task 4: Add context-budget guard

Objective: prevent huge prompt + full toolset requests from silently burning quota.

Files:
- Create: `src/hermes-devin/context-budget.js`
- Create: `test/hermes-devin-context-budget.test.js`

TDD cases:
1. 133057-char last user + 32 tools + GLM policy returns `reject` or `degrade` according to chosen policy.
2. small prompt + reduced tools returns `allow`.
3. large system prompt warning threshold is captured in details.
4. budget output contains measurement fields used by logs.

Decision: initial behavior should be `reject` for fragile model + huge prompt + full toolset, with OpenAI-compatible 413. Degrade is harder and can come after tool pruning exists.

### Task 5: Add rate-limit parser and OpenAI 429 builder

Objective: stop retry storms and expose a clean client contract.

Files:
- Create: `src/hermes-devin/rate-limit.js`
- Create: `test/hermes-devin-rate-limit.test.js`
- Later modify: `src/handlers/chat.js` account retry catch path

TDD cases:
1. `Resets in: 2h59m43s` parses to about 10783000ms.
2. `请 10745 秒后重试` parses to 10745000ms.
3. generic 429 without duration falls back to 60s or existing account retry-after.
4. `buildOpenAIRateLimitError()` returns status 429 and `error.type='rate_limit'`.

### Task 6: Add state-machine trace

Objective: make compatibility decisions inspectable and prevent hidden loops.

Files:
- Create: `src/hermes-devin/state-machine.js`
- Create: `test/hermes-devin-state-machine.test.js`

TDD cases:
1. valid transition path records ordered states.
2. invalid duplicate tool emission transition is rejected.
3. final summary includes request id, model, tool counts, budget action, and terminal state.

### Task 7: Adapter preparation without behavior change

Objective: introduce `prepareHermesDevinRequest()` in shadow mode only.

Files:
- Create: `src/hermes-devin/adapter.js`
- Create: `test/hermes-devin-adapter.test.js`
- Modify: `src/handlers/chat.js`

TDD cases:
1. adapter returns classification + budget + trace for normal request.
2. shadow mode does not alter current `buildToolRoutingPlan()` output.
3. logs can include `CompatRoute[...]` summary.

Implementation:
- Call adapter in `chat.js` near `buildToolRoutingPlan()`.
- In shadow mode, only log decisions; no request blocking yet.

### Task 8: Enforce context reject for fragile huge requests

Objective: prevent the exact 133k prompt / 32 tools / GLM rate-limit burn.

Files:
- Modify: `src/hermes-devin/adapter.js`
- Modify: `src/handlers/chat.js`
- Test: `test/hermes-devin-adapter.test.js` or new route-level test if existing harness supports it.

TDD cases:
1. huge GLM request gets normalized 413 before any mocked upstream call.
2. no account reservation / Cascade call occurs in the test harness.
3. response body matches Hermes error classifier expectations: context/payload too large, not unknown.

### Task 9: Enforce rate-limit fail-fast

Objective: if every eligible account is cooled down, return one clean 429 without sticky retry loops.

Files:
- Modify: `src/handlers/chat.js`
- Modify: `src/hermes-devin/rate-limit.js`
- Tests: existing account routing tests or new `test/hermes-devin-rate-limit.test.js` with mocked account status.

TDD cases:
1. model-level all-unavailable returns OpenAI 429 with retry-after.
2. single rate-limit error records cooldown once.
3. retry loop stops when `isAllTemporarilyUnavailable(modelKey)` is true.

### Task 10: Tool pruning / denied-mode surfacing

Objective: stop sending 32 tools blindly to fragile backends.

Files:
- Modify: `src/hermes-devin/tool-policy.js`
- Modify: `src/hermes-devin/adapter.js`
- Modify: `src/handlers/chat.js`
- Tests: `test/hermes-devin-tool-policy.test.js`, `test/hermes-devin-adapter.test.js`

TDD cases:
1. full Hermes toolset for GLM is reduced to approved core set or rejected depending on context.
2. denied tools are included in logs but not in prompt-emulation preamble for degraded mode.
3. GPT/full-compatible policy can preserve full toolset after certification flag.

### Task 11: Devin ACP backend spike behind a flag

Objective: start replacing Cascade prompt emulation with a real Devin ACP backend for Devin-native sessions.

Files:
- Existing: `src/devin-cloud-acp.js`
- Existing tests: `test/devin-cloud-acp.test.js`
- Create: `src/hermes-devin/acp-backend.js`
- Create: `test/hermes-devin-acp-backend.test.js`

TDD/mocked only:
1. build websocket URL using `buildDevinCloudAcpUrl()`.
2. send initialize request using `buildInitializeRequest()`.
3. send `session/new` and `session/prompt` JSON-RPC shapes from fixture.
4. normalize ACP agent messages into OpenAI assistant content.
5. normalize ACP tool/action requests into OpenAI tool_calls only if mapped and declared.

No live Devin sessions unless Brandon explicitly approves.

---

## 5. Acceptance criteria

S-tier is not done until these are true:

1. Contract doc exists and stays aligned with tests.
2. All compatibility modules have unit tests.
3. The exact huge-prompt memory-fabrication class is impossible by test.
4. Fragile model + huge prompt + broad tools cannot reach upstream by default.
5. Rate-limited model/account produces one clean 429 with retry-after, not a retry storm.
6. Tool routing logs show native/emulated/denied classification, not just `mapped=[none] unmapped=[all]`.
7. Native bridge and Devin ACP paths are separated from local Hermes emulation in code and logs.
8. Live certification is bounded, opt-in, and performed only after mocked tests pass.

---

## 6. Open decisions

1. Context guard behavior for fragile huge prompts: initial plan chooses `reject` over `degrade`. Degrade comes later after tool pruning is proven.
2. Native bridge default: keep off unless remote Devin/Cascade workspace execution is the desired behavior.
3. Devin ACP live session creation: requires explicit approval because it may create remote sessions and consume quota.
4. Full 32-tool certification: only for models that pass the compatibility suite. GLM is not certified for this yet.

---

## 7. Current implementation status

Implemented in the current working tree:

- Bun/TypeScript compatibility boundary:
  - `tsconfig.json`
  - `package.json` scripts: `test:bun`, `test:compat`, `typecheck`, `sync:hermes-devin-ts`
  - test scripts use `DATA_DIR=.test-data` so the suite does not mutate `/home/brandon/.windsurf/accounts.json`
  - `scripts/sync-hermes-devin-ts.mjs` mirrors `src/hermes-devin/*.js` into `.ts` files while the live Node runtime still imports `.js`
- Tool policy and gateway:
  - `src/hermes-devin/tool-policy.js`
  - `src/hermes-devin/tool-gateway.js`
  - every declared Hermes tool remains available to the Hermes tool loop
  - stateful/external tools are not heuristic-recoverable from prose
  - native bridge mapped tools are marked with `executionOwner='cascade_native_bridge'`
  - everything else is marked with `executionOwner='hermes_tool_executor'`
- Model and budget policy:
  - `src/hermes-devin/model-policy.js`
  - `src/hermes-devin/context-budget.js`
  - huge prompt + broad toolset + fragile policy rejects locally before upstream dispatch
- Rate-limit normalization:
  - `src/hermes-devin/rate-limit.js`
  - English and Chinese retry-after parsing
  - OpenAI-compatible 429 builder
  - chat route fail-fast guard when all eligible accounts are locally unavailable
- Route integration:
  - `src/handlers/chat.js` logs gateway diagnostics and enforces context/rate guards
  - `src/handlers/intent-extractor.js` no longer allows broad user-prompt fallback to fabricate unsafe stateful/external tools
  - `src/conversation-pool.js` normalizes system prompt hashes before system digesting
- Trace and adapter shadow layer:
  - `src/hermes-devin/state-machine.js`
  - `src/hermes-devin/adapter.js`
  - `chat.js` calls `prepareHermesDevinRequest()` before account dispatch; normal requests proceed in shadow/preparation mode, local compatibility rejects return before upstream dispatch
- Devin ACP backend payload/execution layer:
  - `src/hermes-devin/acp-backend.js`
  - builds `session/new` and `session/prompt` JSON-RPC shapes
  - flattens OpenAI messages into text-only Devin prompt content
  - normalizes ACP assistant chunks and declared tool requests into OpenAI response/tool-call shapes
  - executes non-streaming ACP chat only behind explicit `HERMES_DEVIN_ACP_BACKEND=1`
  - live ACP tool execution and streaming remain gated off by default
- Test-state isolation:
  - all mutating test scripts now set `DATA_DIR=.test-data`
  - `test/state-isolation-scripts.test.js` locks this regression so broad tests cannot target real account/runtime config files

Verification performed:

```bash
bun run typecheck
bun run test:compat
bun run test:release
CASCADE_REUSE_HASH_SYSTEM=1 WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=0 WINDSURFAPI_FORCE_GLM_DIALECT=glm47 WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF=0 WINDSURFAPI_NATIVE_TOOL_BRIDGE= npm test
git diff --check
curl -fsS http://127.0.0.1:3003/health
curl -fsS http://127.0.0.1:3003/dashboard/api/auth
```

Observed results:

- `bun run typecheck`: passed
- `bun run test:compat`: 60 pass, 0 fail, across 13 files
- `bun run test:release`: 57 pass, 0 fail
- full isolated `npm test`: 1145 pass, 0 fail
- `git diff --check`: passed
- real account file hash unchanged across isolated test suites
- real runtime-config file hash unchanged across isolated test suites
- live health after PM2 restart: `accounts.total=1`, `accounts.active=1`, `accounts.error=0`
- dashboard auth after reset: `/dashboard/api/auth` returns `{"required":false}`
- live guard probe: `glm-5.1` + 133057-char prompt + 32 tools returned local `413 context_length_exceeded` before upstream burn
- low-cost live chat probes reached the server but returned clean local/upstream 429s for cooled-down models instead of retry storms:
  - `kimi-k2-6`: 429 with retry-after
  - `claude-4.5-haiku`: 429 with retry-after
  - `gemini-2.5-flash`: 429 with retry-after

Not implemented yet:

- live successful model response certification, because current account/model pool is cooled down for the probed models
- live ACP prompt send certification is still intentionally not exercised by default; non-streaming ACP execution is implemented and gated behind `HERMES_DEVIN_ACP_BACKEND=1`, but a live run would create remote Devin session activity

## 8. Install / use steps for this branch

From `/home/brandon/dev/windsurf/WindsurfAPI`:

```bash
bun install
bun run typecheck
bun run test:compat
npm test
pm2 restart windsurf-api --update-env
curl -fsS http://127.0.0.1:3003/health
```

If the live account file is missing or empty, restore from Devin credentials without printing secrets:

```bash
python3 - <<'PY'
import json, re, urllib.request
from pathlib import Path
cred = Path('/home/brandon/.local/share/devin/credentials.toml').read_text()
api_key = re.search(r'^windsurf_api_key\s*=\s*"([^"]+)"', cred, re.M).group(1)
req = urllib.request.Request(
  'http://127.0.0.1:3003/auth/login',
  data=json.dumps({'api_key': api_key, 'label': 'devin-credentials-restored'}).encode(),
  headers={'Content-Type':'application/json','Authorization':'Bearer test'},
  method='POST',
)
print(urllib.request.urlopen(req, timeout=10).status)
PY
```

## 9. Immediate next move

After cooldown, run one small successful live `/v1/chat/completions` certification and, if explicitly desired, one live `HERMES_DEVIN_ACP_BACKEND=1` probe knowing it will create remote Devin session activity. Do not run broad-tool or giant-prompt live probes; those are already covered by local guards.
