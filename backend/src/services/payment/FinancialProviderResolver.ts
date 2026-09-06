import type { FinancialProviderPorts } from './FinancialProviderPorts.js';
import {
  createDatabaseBackedFakeFinancialProvider,
  issueLiveFakeFinancialDatabaseCapability,
} from './FakeFinancialProvider.js';
import type { NonproductionFinancialAuthorizationOptions } from './NonproductionFinancialAuthorization.js';

export type FinancialProviderName = 'fake';

/**
 * Resolve the provider-neutral lifecycle adapter.
 *
 * A real provider is intentionally absent. Adding one requires a separately
 * reviewed adapter and certification suite; it cannot be selected by an
 * environment variable before that code exists.
 */
export async function resolveFinancialProvider(
  provider: FinancialProviderName,
  options: NonproductionFinancialAuthorizationOptions = {}
): Promise<FinancialProviderPorts> {
  if (provider === 'fake') {
    const capability = await issueLiveFakeFinancialDatabaseCapability(options);
    return createDatabaseBackedFakeFinancialProvider(capability);
  }
  throw new Error(`UNSUPPORTED_FINANCIAL_PROVIDER:${String(provider)}`);
}
