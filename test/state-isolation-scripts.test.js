import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const MUTATING_TEST_SCRIPTS = [
  'test',
  'test:bun',
  'test:compat',
  'test:release',
  'test:shard',
];

describe('test command state isolation', () => {
  it('runs mutating test entrypoints with DATA_DIR=.test-data so real Windsurf state cannot be touched', () => {
    for (const name of MUTATING_TEST_SCRIPTS) {
      const script = pkg.scripts?.[name] || '';
      assert.match(script, /(?:^|\s)DATA_DIR=\.test-data(?:\s|$)/, `${name} must set DATA_DIR=.test-data before loading src/auth.js or src/runtime-config.js`);
    }
  });
});
