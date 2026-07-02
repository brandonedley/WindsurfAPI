# S-Tier Plan: Native Tool-Calling via `GetChatMessage` / `InferenceRequest`

> Supersedes the tool-transport portions of `hermes-devin-s-tier-compatibility-plan.md` (which is ACP-centric; ACP is a confirmed dead end — the agent owns tool execution). This plan is the empirically-grounded path found 2026-06-23.

## Goal

Give the WindsurfAPI proxy a **third upstream transport** that speaks the modern, tool-carrying inference endpoint the Devin/affogato CLI uses, so that `supports_tool_calls` models (esp. `glm-5.2`) return **native structured tool calls** — and Hermes keeps its own local tool loop. No prompt-emulation, no NLU salvage, no Cascade planner for the tool path.

## Proven facts (do not re-litigate)

- Proxy today has only `RawGetChatMessage` (no tools) and `Cascade` (planner; upstream carries no `tools[]`). Both force fragile prompt-emulation for tools. Measured glm-5.2: glm47 dialect 0/10, gpt_native ~7/10.
- The Devin CLI (Rust crate `affogato`, binary `~/.local/share/devin/cli/_versions/2026.5.26-8/bin/devin`) does **reliable** glm-5.2 tool-calling on the SAME backend via `/exa.api_server_pb.ApiServerService/GetChatMessage`.
- Request type = `InferenceRequest` (fields seen in binary: `messages`, `tools`, `query_label`, `is_user_initiated`, `completion_config`, `max_trailing_images`, `execution_id`, `agent_context`, `system_prefix_len`, `generation_id`, `hosted_tool_search`).
- `ToolDefinition` fields: `name`, `description`, `parameters`, `custom_tool`, `defer_loading`, `strict`.
- Response tool call: `ParsedToolCall{id, inference_tool_name, arguments, index, namespace}` and/or `ChatToolCall{id, arguments_json, is_custom_tool_call}`.
- Per-model config (GetCliModelConfigs / `model_configs_v2.bin`, crate `windsurf-api-client/src/model_registry.rs`): `ModelFeatures.supports_tool_calls`, `supports_parallel_tool_calls`, plus `tool_formatter_type`, `harness_uids`, `inference_server_url`, `chat_model_name`.
- CLI TLS is `rustls` → mitmproxy interception is unreliable. Preferred schema-capture method = field-number reverse-engineering via the proxy's own authenticated Connect client (`src/grpc.js` + `src/proto.js`), reading server decode errors — the same discipline used for Cascade.

## Non-negotiables (no shortcuts)

1. **TDD.** Every new module gets failing tests first, then implementation. No code without a test that exercised RED.
2. **Schema must be live-validated.** Implementation may not be declared done against mocks alone. A real `GetChatMessage` 200 with a parsed tool call is the acceptance gate for the schema.
3. **Do not destabilize the live service.** No `pm2 restart` of `windsurf-api`, no `.env` edits, no edits the running process would pick up on restart, until the user reviews. Work on a branch.
4. **Capability-gated routing.** Only models with `supports_tool_calls=true` go to the new transport; everything else keeps current behavior. New transport behind an env flag (default off) until certified.
5. **Tiny quota.** Schema RE uses minimal 1-tool probes; no giant prompts, no broad-tool live runs.
6. **Honest status.** If the live schema can't be validated, say so and stop — do not claim done.

## Phases

### Phase 1 — Recon (read-only, parallel)
- Extract `InferenceRequest` / `ToolDefinition` / `ParsedToolCall` / `ChatToolCall` field order + type hints from the devin binary (`strings`, struct-element counts).
- Map the proxy's Connect/gRPC plumbing: `src/grpc.js` (how a unary/stream Connect call is made + auth headers + framing), `src/proto.js` (schema-less encode/decode primitives), `src/client.js` (`rawGetChatMessage` as the template), `src/windsurf.js` (existing request builders + field-number conventions).
- Inventory reusable `src/hermes-devin/*` (model-policy, tool-policy, adapter) + existing tests.

### Phase 2 — Schema reverse-engineering (the linchpin; sequential, live tiny probes)
- Write `scripts/getchatmessage-schema-probe.mjs` using the proxy's authenticated Connect client to POST to `ApiServerService/GetChatMessage` with a hand-built `InferenceRequest` (one user message + one `ToolDefinition` for a `run_shell(command)` tool, `model=glm-5-2`).
- Iterate field numbers using server decode/validation errors until a **live 200** returns a parseable `ParsedToolCall`/`ChatToolCall`.
- Output: exact field numbers for `InferenceRequest`, `ToolDefinition`, `CompletionConfig`, message shape, and the response tool-call message; plus a captured sample (redacted).
- **Gate:** if no live 200, document the furthest-validated schema + the precise blocker and STOP before Phase 3.

### Phase 3 — Implement (TDD, on a branch)
- `src/getchatmessage.js`: `buildInferenceRequest(messages, tools, model, completionConfig)` + `parseGetChatMessageResponse(bytes)` → `{text, toolCalls[], usage}`. Pure functions, unit-tested with golden fixtures from Phase 2.
- `src/client.js`: `getChatMessageWithTools(...)` mirroring `rawGetChatMessage` (Connect stream, auth, abort, error mapping).
- `src/handlers/chat.js`: route to the new transport when model `supports_tool_calls` AND `WINDSURFAPI_GETCHATMESSAGE_TOOLS=1`; map `ParsedToolCall → OpenAI tool_calls`; preserve streaming + non-streaming + tool-result continuation (tool/assistant history round-trips through `InferenceRequest.messages`).
- `src/models.js`/registry: surface `supports_tool_calls` from GetCliModelConfigs.
- Tests: `test/getchatmessage-encode.test.js`, `test/getchatmessage-parse.test.js`, `test/getchatmessage-routing.test.js` (mock upstream: tool call, parallel tool calls, text-only, tool-result continuation, error).

### Phase 4 — Verify
- `npm test` green (new + existing, isolated `DATA_DIR=.test-data`).
- One **gated** live certification: a single non-stream `glm-5.2` request with one tool through the new transport returns a real `tool_calls`. Then a 10× reliability run (target: ≥9/10, vs gpt_native 7/10).

### Phase 5 — Adversarial review
- code-reviewer agent over the branch diff: correctness of proto field numbers, tool-result continuation, streaming deltas, error/abort paths, security (no fabricated tool calls, allowlist still enforced), and that the live service path is unchanged when the flag is off.

## Acceptance criteria

1. Live `GetChatMessage` 200 with a parsed structured tool call for glm-5.2 (schema validated).
2. New transport behind `WINDSURFAPI_GETCHATMESSAGE_TOOLS=1`, default off; flag-off behavior byte-identical to today.
3. Unit + mock tests cover encode/parse/route/continuation/errors; all green.
4. Live reliability ≥9/10 on the glm-5.2 single-tool probe.
5. Branch ready for review; live pm2 service untouched.
6. Review verdict: no high-severity issues open.
