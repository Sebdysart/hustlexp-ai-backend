/**
 * Error Manifest Generator v1.0.0
 *
 * Generates JSON manifest of all HX error codes for iOS validation.
 * iOS TRPCClient can validate that error codes referenced in Swift match backend registry.
 *
 * @see backend/src/lib/error-code-registry.ts
 * @see .github/workflows/holodeck.yml (dispatches manifest to iOS)
 */

import fs from 'fs';
import path from 'path';
import { ERROR_CODES, getAllCategories } from '../src/lib/error-code-registry';

interface ErrorManifest {
  version: string;
  generatedAt: string;
  totalCodes: number;
  categories: string[];
  codes: Array<{
    code: string;
    message: string;
    httpStatus: number;
    userFacing: boolean;
    category: string;
  }>;
}

/**
 * Generate error manifest
 */
export function generateErrorManifest(): ErrorManifest {
  const codes = Object.values(ERROR_CODES);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalCodes: codes.length,
    categories: getAllCategories(),
    codes: codes.map(code => ({
      code: code.code,
      message: code.message,
      httpStatus: code.httpStatus,
      userFacing: code.userFacing,
      category: code.category,
    })),
  };
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const manifest = generateErrorManifest();

  console.log('===== ERROR CODE MANIFEST =====\n');
  console.log(`Total Codes: ${manifest.totalCodes}`);
  console.log(`Categories: ${manifest.categories.join(', ')}\n`);

  // Group by category
  manifest.categories.forEach(category => {
    const categoryCodes = manifest.codes.filter(c => c.category === category);
    console.log(`${category.toUpperCase()}: ${categoryCodes.length} codes`);
    categoryCodes.forEach(c => {
      const facing = c.userFacing ? '👤' : '🔒';
      console.log(`  ${facing} ${c.code} - ${c.message} (${c.httpStatus})`);
    });
    console.log();
  });

  // Write JSON manifest
  const outputPath = path.join(process.cwd(), 'error-manifest.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved to: ${outputPath}`);

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `error_manifest_path=${outputPath}\n` +
      `total_error_codes=${manifest.totalCodes}\n`
    );
  }
}
