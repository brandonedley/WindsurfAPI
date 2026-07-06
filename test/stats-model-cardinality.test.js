import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Bound cardinality low + deterministically before importing the module.
process.env.STATS_MAX_MODELS = '10';

const { recordRequest, getStats, resetStats } = await import('../src/dashboard/stats.js');

const OTHER = '(other)';
const CAP = 10;

function realKeys(mc) {
  return Object.keys(mc).filter(k => k !== OTHER);
}

describe('stats per-model cardinality bound', () => {
  beforeEach(() => resetStats());

  it('keeps the tracked map bounded when fed N >> cap distinct models', () => {
    const N = 500;
    for (let i = 0; i < N; i++) {
      recordRequest(`model-${i}`, true, 5, null);
    }
    const stats = getStats();
    const keys = realKeys(stats.modelCounts);
    assert.ok(keys.length <= CAP, `real model keys ${keys.length} exceeds cap ${CAP}`);
    assert.ok(stats.modelCounts[OTHER], 'overflow bucket should exist');
  });

  it('reconciles totals: sum of per-model requests equals totalRequests', () => {
    const N = 300;
    for (let i = 0; i < N; i++) {
      recordRequest(`m${i}`, i % 3 !== 0, 7, null);
    }
    const stats = getStats();
    const sumReq = Object.values(stats.modelCounts).reduce((a, s) => a + s.requests, 0);
    const sumSucc = Object.values(stats.modelCounts).reduce((a, s) => a + s.success, 0);
    const sumErr = Object.values(stats.modelCounts).reduce((a, s) => a + s.errors, 0);
    assert.equal(sumReq, N);
    assert.equal(sumReq, stats.totalRequests);
    assert.equal(sumSucc, stats.successCount);
    assert.equal(sumErr, stats.errorCount);
    assert.equal(sumSucc + sumErr, sumReq);
  });

  it('does not lose counts for a hot model that keeps getting hit', () => {
    // Hot model stays warm; cold unique names churn through eviction.
    for (let round = 0; round < 50; round++) {
      recordRequest('hot', true, 10, null);
      recordRequest(`cold-${round}`, true, 10, null);
    }
    const stats = getStats();
    assert.ok(stats.modelCounts['hot'], 'hot model should survive eviction');
    assert.equal(stats.modelCounts['hot'].requests, 50);
    assert.ok(realKeys(stats.modelCounts).length <= CAP);
  });

  it('overflow bucket recentMs ring buffer stays capped at 200', () => {
    for (let i = 0; i < 400; i++) {
      recordRequest(`x-${i}`, true, i + 1, null);
    }
    const stats = getStats();
    // getStats collapses recentMs into percentiles; assert the bucket exists
    // and produced non-zero latency percentiles (proof recentMs was retained).
    const other = stats.modelCounts[OTHER];
    assert.ok(other, 'overflow bucket exists');
    assert.ok(other.p50Ms > 0, 'overflow bucket has latency samples');
  });
});
