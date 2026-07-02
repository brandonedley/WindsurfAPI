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

// Three accepted isolation mechanisms:
//  - `--import ./test/setup-env.mjs` (upstream): sets WINDSURFAPI_SKIP_DOTENV=1
//    and points DATA_DIR at a per-process mkdtemp before any module loads.
//  - `DATA_DIR=.test-data` env prefix (bun scripts, which cannot use node's
//    --import hook): redirects state writes into a throwaway repo-local dir.
//  - `scripts/run-test-shard.mjs`, which injects the setup-env import into
//    every shard it spawns (see TEST_SETUP in that script).
// Any of these prevents a test run from serializing the test process's empty
// account pool over the REAL ~/.windsurf/accounts.json (the production-wipe
// bug this test pins).
const ISOLATION = /(?:--import\s+\.\/test\/setup-env\.mjs)|(?:(?:^|\s)DATA_DIR=\.test-data(?:\s|$))|(?:scripts\/run-test-shard\.mjs)/;

describe('test command state isolation', () => {
  it('runs mutating test entrypoints with an isolated DATA_DIR so real Windsurf state cannot be touched', () => {
    for (const name of MUTATING_TEST_SCRIPTS) {
      const script = pkg.scripts?.[name] || '';
      assert.match(script, ISOLATION, `${name} must isolate DATA_DIR (setup-env.mjs import or DATA_DIR=.test-data) before loading src/auth.js or src/runtime-config.js`);
    }
  });

  it('node test runners that skip .env do not also need the DATA_DIR prefix (setup-env owns it)', () => {
    const script = pkg.scripts?.test || '';
    assert.match(script, /--import\s+\.\/test\/setup-env\.mjs/, 'main test script should use the setup-env import');
  });
});
