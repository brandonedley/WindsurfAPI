/**
 * Model name → DEVIN_CONNECT selector resolver.
 *
 * GetChatMessageRequest.model_selector (proto field #21) takes a STRING selector,
 * not the Cascade modelUid/enum. The full catalog was frame-captured from a live
 * GetCliModelConfigs response (see .workflow-results/devin-protobuf/
 * model-catalog-CAPTURED.md and memory: devin-getchatmessage-wire-calibrated-
 * 2026-06-30). This maps the OpenAI-style model names a client sends onto the
 * verified upstream selectors.
 *
 * Free-tier accounts only resolve `swe-1-6-slow`; every other selector returns
 * "/upgrade to access this model". That's an account-tier wall, not a protocol
 * gap — the mapping is complete and ready for a paid entitlement.
 */

import { readFileSync } from 'node:fs';
import { log } from './config.js';

// Canonical OpenAI-ish name / alias → upstream selector (#21). Both the
// dash-form and enum-form selectors are accepted by the API; we prefer the
// dash-form where the catalog exposed one.
const SELECTOR_MAP = new Map(Object.entries({
  // ── SWE / Cognition (free-tier reachable) ──
  'swe-1-6-slow': 'swe-1-6-slow',
  'swe-1.6-slow': 'swe-1-6-slow',
  'swe-1-6': 'swe-1-6',
  'swe-1.6': 'swe-1-6',
  'swe-1-6-fast': 'swe-1-6-fast',
  'swe-1.6-fast': 'swe-1-6-fast',
  'swe-1-5': 'MODEL_SWE_1_5_SLOW',
  'swe-1.5': 'MODEL_SWE_1_5_SLOW',
  'swe-1-5-fast': 'MODEL_SWE_1_5',
  'swe-1.5-fast': 'MODEL_SWE_1_5',
  'subagent-default': 'subagent-default',

  // ── Anthropic (paid) ──
  // opus-4-8 → -medium is frame-verified (see resolver header). The bare
  // Cursor/OpenAI-style forms (no `claude-` prefix) exist in models.js's alias
  // table, and chat.js passes the RAW request model name to resolveConnectSelector
  // (not the models.js-resolved key), so without these entries a client asking
  // for bare `opus-4-8` on the DEVIN_CONNECT path silently degrades to the free
  // selector (issue #203). All point at the same frame-verified catalog selector.
  'claude-opus-4-8': 'claude-opus-4-8-medium',
  'claude-opus-4.8': 'claude-opus-4-8-medium',
  'claude-opus-4-8-medium': 'claude-opus-4-8-medium',
  'opus-4-8': 'claude-opus-4-8-medium',
  'opus-4.8': 'claude-opus-4-8-medium',
  // NB: bare dashed `claude-sonnet-4-6` is itself a real catalog selector now
  // (the base, non-thinking model — reachable 2026-07-05), so it must resolve to
  // ITSELF via the catalog fallthrough, not be remapped. Only the dotted family
  // alias `claude-sonnet-4.6` carries the curated -thinking default.
  'claude-sonnet-4.6': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6-thinking',
  'claude-opus-4-5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4.5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4-5-thinking': 'MODEL_CLAUDE_4_5_OPUS_THINKING',
  'claude-sonnet-4-5': 'MODEL_PRIVATE_2',
  'claude-sonnet-4.5': 'MODEL_PRIVATE_2',
  'claude-sonnet-4-5-thinking': 'MODEL_PRIVATE_3',
  'claude-haiku-4-5': 'MODEL_PRIVATE_11',
  'claude-haiku-4.5': 'MODEL_PRIVATE_11',

  // ── OpenAI (paid) ──
  // The catalog advertises bare `gpt-5.5` as the alias for gpt-5-5-low, so the
  // bare form must resolve too — otherwise a client sending the catalog's own
  // alias normalizes to `gpt-5-5`, misses the map, and silently degrades to the
  // free selector (mapped:false). Keep the bare + suffixed forms in lockstep.
  'gpt-5-5': 'gpt-5-5-low',
  'gpt-5.5': 'gpt-5-5-low',
  'gpt-5-5-low': 'gpt-5-5-low',
  'gpt-5.5-low': 'gpt-5-5-low',
  'gpt-5-2': 'MODEL_GPT_5_2_NONE',
  'gpt-5.2': 'MODEL_GPT_5_2_NONE',
  'gpt-5-2-low': 'MODEL_GPT_5_2_LOW',
  'gpt-5-2-medium': 'MODEL_GPT_5_2_MEDIUM',
  'gpt-5-2-high': 'MODEL_GPT_5_2_HIGH',
  'gpt-5-2-xhigh': 'MODEL_GPT_5_2_XHIGH',

  // ── Google (paid) ──
  // Catalog advertises the family alias as `gemini-3.0-flash` (with the .0),
  // which normalizes to `gemini-3-0-flash`. Keep both that and the shorter
  // `gemini-3-flash` form pointing at the MEDIUM default so the catalog's own
  // alias resolves instead of degrading to free.
  'gemini-3-0-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3.0-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash-minimal': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL',
  'gemini-3-flash-low': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW',
  'gemini-3-flash-medium': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-flash-high': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH',

  // ── Others (paid) ──
  'glm-5-2': 'glm-5-2',
  'glm-5.2': 'glm-5-2',
  'kimi-k2-7': 'kimi-k2-7',

  // ── Paid roster confirmed reachable 2026-07-05 (teams token, direct-selector
  // probe, .workflow-results/paid-live-2026-07-05/) ── each maps a catalog family
  // alias to its -medium (or base/low) default; all targets are in the refreshed
  // 105-model catalog snapshot. See RESULTS.md §2 for the reachability matrix.
  'claude-5-fable': 'claude-5-fable-medium',
  'claude-sonnet-5': 'claude-sonnet-5-medium',
  'claude-opus-4-7': 'claude-opus-4-7-medium',
  'claude-opus-4.7': 'claude-opus-4-7-medium',
  'claude-opus-4.6': 'claude-opus-4-6',
  'gpt-5-4': 'gpt-5-4-medium',
  'gpt-5.4': 'gpt-5-4-medium',
  'gpt-5-4-mini': 'gpt-5-4-mini-medium',
  'gpt-5.4-mini': 'gpt-5-4-mini-medium',
  'gpt-5-3-codex': 'gpt-5-3-codex-medium',
  'gpt-5.3-codex': 'gpt-5-3-codex-medium',
  'gemini-3-5-flash': 'gemini-3-5-flash-medium',
  'gemini-3.5-flash': 'gemini-3-5-flash-medium',
  'gemini-3-1-pro': 'gemini-3-1-pro-low',
  'gemini-3.1-pro': 'gemini-3-1-pro-low',
  'glm-5.1': 'glm-5-1',
  'kimi-k2.6': 'kimi-k2-6',
  'kimi-k2.7': 'kimi-k2-7',
}));

// The set of selectors the live catalog actually exposes (committed snapshot,
// frame-verified 2026-06-30). A value written to GetChatMessageRequest #21 that
// is NOT in this set makes the upstream return UPSTREAM_INTERNAL (frame-proven
// 2026-07-04: bare "claude-opus-4-8" failed, "claude-opus-4-8-medium" 200'd).
// Used as a last-line existence guard on enum/dash-form passthrough. Loaded the
// same way other src modules read JSON fixtures (JSON.parse + readFileSync), so
// this stays a zero-dep ESM module with no import assertion.
const CATALOG_SELECTORS = new Set(
  JSON.parse(
    readFileSync(new URL('../test/fixtures/devin-catalog-snapshot.json', import.meta.url), 'utf8'),
  ).models.map((m) => m.selector),
);

// The only selector a free-tier account can actually run. Used as the safe
// default when DEVIN_CONNECT is enabled but the requested model isn't mapped.
export const FREE_TIER_SELECTOR = 'swe-1-6-slow';

/**
 * Resolve a client-supplied model name to an upstream DEVIN_CONNECT selector.
 * Normalizes case and dot/dash variations. Returns the free-tier default for
 * unknown names so an enabled DEVIN_CONNECT deploy never hard-fails on an
 * unmapped alias — it degrades to the one selector that always works.
 *
 * @param {string} model
 * @returns {{ selector: string, mapped: boolean }}
 */
export function resolveConnectSelector(model) {
  const raw = String(model || '').trim();
  if (!raw) return { selector: FREE_TIER_SELECTOR, mapped: false };

  // Direct hit (covers both dash-form and enum-form selectors passed verbatim).
  if (SELECTOR_MAP.has(raw)) return { selector: SELECTOR_MAP.get(raw), mapped: true };

  // Normalize: lowercase, collapse dots to dashes, strip a leading provider
  // prefix some clients prepend (e.g. "anthropic/claude-...").
  const norm = raw.toLowerCase().replace(/^[a-z]+\//, '').replace(/\./g, '-');
  if (SELECTOR_MAP.has(norm)) return { selector: SELECTOR_MAP.get(norm), mapped: true };

  // Enum-form passthrough — ONLY when the catalog actually exposes it. A blind
  // MODEL_* passthrough is what re-introduces UPSTREAM_INTERNAL on drift: any
  // bogus MODEL_DOES_NOT_EXIST would otherwise be written raw to #21.
  if (/^MODEL_[A-Z0-9_]+$/.test(raw) && CATALOG_SELECTORS.has(raw)) {
    return { selector: raw, mapped: true };
  }

  // A verbatim dash-form selector that IS in the catalog but missing from the
  // map (e.g. a lowercased/prefixed valid enum) should still go through rather
  // than silently degrade a paid request to the free tier.
  if (CATALOG_SELECTORS.has(raw)) return { selector: raw, mapped: true };

  // Unmapped: degrade to the always-available free selector, but make it
  // OBSERVABLE (one-time per distinct model) so a caller ignoring mapped:false
  // still gets an operator signal that a paid model was downgraded to free.
  if (!degradeWarned.has(raw)) {
    degradeWarned.add(raw);
    log.warn(
      `[devin-connect] unmapped model "${raw}" not in catalog — degrading to `
      + `${FREE_TIER_SELECTOR} (paid request downgraded to free tier)`,
    );
  }
  return { selector: FREE_TIER_SELECTOR, mapped: false };
}

// Tracks model names we've already warned about so the degrade signal fires
// once per distinct name rather than on every request (avoids log flooding).
const degradeWarned = new Set();

export const __testing = { SELECTOR_MAP, CATALOG_SELECTORS, degradeWarned };
