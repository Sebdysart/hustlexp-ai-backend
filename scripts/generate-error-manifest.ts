/**
 * generate-error-manifest.ts
 *
 * Reads the error code registry and outputs a JSON manifest to stdout.
 * Used by the Holodeck CI workflow for cross-surface validation.
 *
 * Usage: npx tsx scripts/generate-error-manifest.ts > error-manifest.json
 */

import { getAllCodes } from '../backend/src/lib/error-code-registry.js';

interface ErrorManifest {
  generatedAt: string;
  codes: Array<{
    code: string;
    message: string;
    httpStatus: number;
    category: string;
    userFacing: boolean;
  }>;
}

function main(): void {
  const allCodes = getAllCodes();

  const manifest: ErrorManifest = {
    generatedAt: new Date().toISOString(),
    codes: allCodes.map(entry => ({
      code: entry.code,
      message: entry.message,
      httpStatus: entry.httpStatus,
      category: entry.category,
      userFacing: entry.userFacing,
    })),
  };

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

main();
