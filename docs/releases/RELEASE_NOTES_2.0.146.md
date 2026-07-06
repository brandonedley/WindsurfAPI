## v2.0.146 - audit hardening + live-verified model roster

A snapshot release: a full read-only security/correctness audit landed as
concrete fixes, the model catalog was refreshed against the live upstream, and
the DEVIN_CONNECT direct-cloud path was verified end-to-end against a paid
account. No behavior change on normal traffic — the security items only bound
malformed/hostile inputs, and the new model mappings and wire-tag decoders are
additive (env-gated where relevant).

### Security / correctness (audit follow-up)
Eleven adversarially-verified findings fixed, each with regression tests:

- **Dashboard AUTH-1**: localhost-with-no-secret now fails closed by default
  (opt back into open-local dev with `DASHBOARD_ALLOW_NO_AUTH=1`); dashboard
  CORS is no longer a blanket `*` (allowlist via `DASHBOARD_CORS_ORIGINS`);
  `reveal-key` requires in-request re-auth; `self-update {forceReset}` refuses
  to drop unpushed commits unless `DASHBOARD_ALLOW_HARD_RESET=1`.
- **Brute-force lockout (XFF-1)**: the dashboard client-IP now counts
  `X-Forwarded-For` from the right (`TRUST_PROXY_HOPS`), so a spoofed left-most
  token can't evade the lockout.
- **Two process-crash paths closed**: `devin-acp` child `stdin` EPIPE and a
  malformed gRPC `grpc-message` trailer no longer become an uncaughtException
  that takes down the whole proxy.
- **Tenant isolation**: an empty `body.user` no longer collapses distinct end
  users of a shared key into one cache/cascade scope; tool_result neutralization
  now covers every tool dialect (kimi/gpt-native), not just the XML one.
- **Resource bounds**: dashboard `modelCounts` cardinality is capped
  (`STATS_MAX_MODELS`); error-account recovery timestamps persist so a restart
  no longer strands accounts as permanently disabled.
- **DEVIN_CONNECT streaming**: the direct path now wires client-disconnect
  abort, heartbeat, and SSE-registry drain (matching the Cascade path), so a
  disconnected client stops the failover loop from burning quota; first-connect
  transient errors keep their recovery armed.

### Model catalog + routing (issue #203)
- Refreshed the catalog snapshot to the **live 105-model roster** and mapped
  the full reachable flagship set — Opus 4.8 (all efforts), Sonnet 5, Fable 5,
  GPT-5.4, GPT-5.3-codex, Gemini 3.5-flash, Gemini 3.1-pro, DeepSeek V4, and
  more — so clients sending these names no longer silently degrade to the free
  tier on the DEVIN_CONNECT path.
- Fixed bare `opus-4-8` / `opus-4.8` degrading to free-tier (#203), and added a
  catalog-existence guard so an unknown selector degrades observably (a warn)
  instead of silently.
- Requesting `claude-opus-4-8` on a paid account now resolves to the
  frame-verified `claude-opus-4-8-medium` selector and returns real Opus 4.8
  content end-to-end (verified over the full HTTP stack).

### Wire protocol (opt-in decoders)
- `actual_model_uid` is decoded from its frame-verified location (metadata
  `#7.9`) when `DEVIN_CONNECT_ACTUAL_MODEL_TAG=9` is set.
- Native tool_call arguments that stream fragmented across frames are now
  coalesced by id, reconstructing the full JSON.

### Docs
- Removed internal maintainer/reversing working notes from the public repo;
  the docs tree now carries only operational and contributor documentation.
