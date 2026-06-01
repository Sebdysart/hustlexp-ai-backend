/**
 * emit-approuter-types.ts
 *
 * Bundles the tRPC AppRouter type tree into a single self-contained
 * `dist-types/AppRouter.d.ts` for downstream consumers (web app, admin
 * dashboard, future SDKs) that cannot import from this repo directly.
 *
 * The output is the published contract — commit it to the branch after
 * any backend API change so consumers can vendor a fresh snapshot via
 * `gh api repos/Sebdysart/hustlexp-ai-backend/contents/dist-types/AppRouter.d.ts`.
 *
 * Run: `npm run emit:trpc-types`
 */

import { generateDtsBundle } from 'dts-bundle-generator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const entryFile = resolve(repoRoot, 'backend/src/routers/index.ts');
const outFile = resolve(repoRoot, 'dist-types/AppRouter.d.ts');
const project = resolve(repoRoot, 'tsconfig.src.json');

const [bundled] = generateDtsBundle(
  [
    {
      filePath: entryFile,
      output: { inlineDeclareGlobals: true, noBanner: false },
    },
  ],
  { preferredConfigPath: project }
);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, bundled, 'utf8');

const lines = bundled.split('\n').length;
process.stdout.write(`Wrote ${outFile} (${lines} lines)\n`);

if (!bundled.includes('export type AppRouter')) {
  process.stderr.write('FATAL: bundle does not export AppRouter type\n');
  process.exit(1);
}
