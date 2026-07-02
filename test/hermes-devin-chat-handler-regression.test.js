import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const chatSource = () => readFileSync('src/handlers/chat.js', 'utf8');

describe('Hermes Devin chat handler strict adapter regressions', () => {
  it('does not blanket adapter_error every text-only fragile-model response when tools are declared', () => {
    const source = chatSource();
    assert.doesNotMatch(
      source,
      /if \(emulateTools && Array\.isArray\(tools\) && tools\.length > 0 && toolCalls\.length === 0 && fragileModel\)/,
    );
  });

  it('keeps strict adapter_error guarded by narrated tool intent detection', () => {
    const source = chatSource();
    assert.match(source, /looksLikeNarratedToolIntent\(narrativeSourceForStrictAdapter\)/);
    assert.match(source, /tool_call_required_but_not_emitted/);
  });

  it('does not contain literal backspace control characters in the narration regex', () => {
    const source = chatSource();
    const start = source.indexOf('function looksLikeNarratedToolIntent');
    const end = source.indexOf('function logBridgeResultDiagnostics', start);
    const block = source.slice(start, end);
    assert.equal(block.includes('\b'), false);
    assert.ok(block.includes('\\b(?:I'), block);
    assert.ok(block.includes(')\\b|'), block);
  });

  it('wraps successful forced non-stream fragile responses back into SSE for stream callers', () => {
    const source = chatSource();
    assert.match(source, /function wrapNonStreamCompletionAsSse/);
    assert.match(source, /if \(forcedFragileNonStream && result\.status === 200\)/);
  });
});
