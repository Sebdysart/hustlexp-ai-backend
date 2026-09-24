import { db } from '../../db.js';
import type { TilledEnvironment } from './TilledConfig.js';

export interface TilledMerchantAccount {
  organizationId: string;
  accountId: string;
  environment: TilledEnvironment;
  status: string;
  chargesEnabled: boolean;
}

export async function resolveTilledMerchantAccount(
  organizationId: string,
  environment: TilledEnvironment,
  requireActive = true,
): Promise<TilledMerchantAccount | null> {
  const result = await db.query<{
    organization_id: string;
    provider_account_id: string;
    environment: TilledEnvironment;
    status: string;
    charges_enabled: boolean;
  }>(
    `SELECT organization_id, provider_account_id, environment, status, charges_enabled
     FROM business_payment_accounts
     WHERE organization_id = $1 AND provider = 'tilled' AND environment = $2
     LIMIT 1`,
    [organizationId, environment],
  );
  const account = result.rows[0];
  if (!account || (requireActive && (account.status !== 'ACTIVE' || !account.charges_enabled))) {
    return null;
  }
  return {
    organizationId: account.organization_id,
    accountId: account.provider_account_id,
    environment: account.environment,
    status: account.status,
    chargesEnabled: account.charges_enabled,
  };
}
