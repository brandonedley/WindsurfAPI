## v2.0.147 - tool_calls in thinking + opus-4.8 tier ladder + catalog self-heal

Merges the community PR #206 (thanks @kosonen) plus repo housekeeping.

### Tool calling
- **Extract tool_calls from thinking content.** High-reasoning models (Opus 4.8
  xhigh and similar) sometimes emit the `<tool_call>` block inside
  reasoning_content instead of the main text, so the text-only parser missed it
  and the client saw "no tool called". The parser now falls back to scanning
  thinking, and the SSE block ordering is fixed so Claude Code no longer reports
  "Content block not found" when a tail tool_use follows reasoning. (issue #178)
- `reasoning_effort` now **replaces** an existing effort suffix instead of being
  ignored — `claude-opus-4-8-medium` + `reasoning.effort=xhigh` resolves to the
  xhigh tier (the explicit effort field wins).

### Models
- **Opus 4.8 full effort ladder**: low / medium / high / xhigh / max plus the
  priority (`-fast`) lanes, with per-tier credits, matching the live upstream
  catalog.
- **Catalog self-heal**: the cloud model catalog now re-syncs when the first
  account becomes active (or recovers), not only at startup — so a deploy that
  had no active account at boot still picks up the upstream roster. (issues
  #203 / #190)

### API surface
- Added `GET /v1/models/{id}` (Anthropic-style single-model lookup).

### Housekeeping
- README: replaced the old H1 with the project name + a capability tagline.
- Documented the v2.0.146 dashboard fail-closed default and the new env vars
  (DASHBOARD_ALLOW_NO_AUTH / DASHBOARD_CORS_ORIGINS / DASHBOARD_ALLOW_HARD_RESET,
  DEVIN_CONNECT_ACTUAL_MODEL_TAG / TOOL_CALL_TAGS / EAGER_PRIME, STATS_MAX_MODELS)
  in .env.example.
- Moved the two stray root-level release notes into docs/releases/.

Full suite: 2271 tests green.
