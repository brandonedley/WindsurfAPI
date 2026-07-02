import { mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'src/hermes-devin/types.ts',
  'src/hermes-devin/errors.ts',
  'src/hermes-devin/protocol.ts',
  'src/hermes-devin/tool-policy.ts',
  'src/hermes-devin/tool-gateway.ts',
  'src/hermes-devin/model-policy.ts',
  'src/hermes-devin/context-budget.ts',
  'src/hermes-devin/rate-limit.ts',
  'src/hermes-devin/state-machine.ts',
  'src/hermes-devin/adapter.ts',
  'src/hermes-devin/acp-backend.ts',
];

const outDir = join(root, '.hermes/tmp/hermes-devin-js');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = spawnSync('bunx', [
  'tsc',
  '--ignoreConfig',
  '--target', 'ES2022',
  '--module', 'ESNext',
  '--moduleResolution', 'Bundler',
  '--skipLibCheck',
  '--strict', 'false',
  '--allowJs', 'false',
  '--declaration', 'false',
  '--sourceMap', 'false',
  '--noEmit', 'false',
  '--outDir', outDir,
  ...sources,
], {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) process.exit(result.status || 1);

for (const rel of sources) {
  const jsRel = rel.replace(/\.ts$/, '.js');
  await copyFile(join(outDir, jsRel.split('/').at(-1)), join(root, jsRel));
}

console.log(`Generated ${sources.length} runtime JavaScript modules from TypeScript source.`);
