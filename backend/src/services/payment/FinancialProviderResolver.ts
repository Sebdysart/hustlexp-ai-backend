import { buildIdentity, type BuildIdentity } from '../../buildIdentity.js';
import type { Database } from '../../db.js';
import { readReleaseManifest, type ReleaseManifestEvidence } from '../../releaseManifest.js';
import type { FinancialProviderPorts } from './FinancialProviderPorts.js';
import { createDatabaseBackedFakeFinancialProvider } from './FakeFinancialProvider.js';

export type FinancialProviderName = 'fake';

/**
 * Resolve the provider-neutral lifecycle adapter.
 *
 * A real provider is intentionally absent. Adding one requires a separately
 * reviewed adapter and certification suite; it cannot be selected by an
 * environment variable before that code exists.
 */
export function resolveFinancialProvider(
  provider: FinancialProviderName,
  database?: Database,
  environment: NodeJS.ProcessEnv = process.env,
  release: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity,
): FinancialProviderPorts {
  if (provider === 'fake') {
    return createDatabaseBackedFakeFinancialProvider(database, environment, release, identity);
  }
  throw new Error(`UNSUPPORTED_FINANCIAL_PROVIDER:${String(provider)}`);
}
