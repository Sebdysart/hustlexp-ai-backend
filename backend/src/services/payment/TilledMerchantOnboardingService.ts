import { TRPCError } from '@trpc/server';

import { db, type QueryFn } from '../../db.js';
import { logger } from '../../logger.js';
import {
  TilledApiError,
  TilledClient,
  type TilledConnectedAccount,
  type TilledOnboardingStatus,
  type TilledUserInvitation,
} from './TilledClient.js';
import {
  loadTilledOnboardingConfig,
  type TilledEnvironment,
} from './TilledConfig.js';

type LocalOnboardingState = 'RESERVED' | 'CREATING' | 'BOUND' | 'RECONCILE_REQUIRED';
type LocalInvitationState = 'NOT_CREATED' | 'CREATING' | 'CREATED' | 'RECONCILE_REQUIRED';
type LocalAccountStatus = 'PENDING' | 'ACTIVE' | 'IN_REVIEW' | 'DISABLED' | 'REJECTED' | 'WITHDRAWN';

interface PaymentAccountRow {
  id: string;
  organization_id: string;
  provider_account_id: string;
  application_id: string | null;
  status: LocalAccountStatus;
  charges_enabled: boolean;
  provider_onboarding_status: TilledOnboardingStatus | null;
  onboarding_state: LocalOnboardingState;
  provider_user_invitation_id: string | null;
  invitation_state: LocalInvitationState;
  invitation_email: string | null;
  last_synced_at: Date | null;
  updated_at: Date;
}

interface BusinessContext {
  organizationId: string;
  displayName: string;
  email: string;
}

export type BusinessPaymentSetupStatus =
  | 'not_started'
  | 'action_required'
  | 'submitted'
  | 'under_review'
  | 'active'
  | 'rejected'
  | 'disabled'
  | 'withdrawn'
  | 'reconciliation_required';

export interface BusinessPaymentOnboardingResult {
  organizationId: string;
  environment: TilledEnvironment;
  status: BusinessPaymentSetupStatus;
  providerStatus: TilledOnboardingStatus | null;
  chargesEnabled: boolean;
  onboardingAction: 'none' | 'create_invitation' | 'check_email' | 'open_invitation';
  invitationUrl?: string;
}

const paymentAccountColumns = `
  id,
  organization_id,
  provider_account_id,
  application_id,
  status,
  charges_enabled,
  provider_onboarding_status,
  onboarding_state,
  provider_user_invitation_id,
  invitation_state,
  invitation_email,
  last_synced_at,
  updated_at
`;

function reservationAccountId(organizationId: string, environment: TilledEnvironment): string {
  return `tilled_onboarding:${organizationId}:${environment}`;
}

function onboardingMetadata(organizationId: string, environment: TilledEnvironment) {
  return {
    hustlexp_organization_id: organizationId,
    hustlexp_environment: environment,
  };
}

async function authorizeAndLoadBusiness(
  query: QueryFn,
  organizationId: string,
  actorId: string,
): Promise<BusinessContext> {
  await query(
    `SELECT business_require_action($1::uuid, $2::uuid, 'MANAGE_BILLING')`,
    [organizationId, actorId],
  );
  const result = await query<{
    organization_id: string;
    display_name: string;
    email: string;
    status: string;
    provider_enabled: boolean;
  }>(
    `SELECT organization.id AS organization_id,
            organization.display_name,
            actor.email,
            organization.status,
            organization.provider_enabled
       FROM business_organizations organization
       JOIN users actor ON actor.id = $2::uuid
      WHERE organization.id = $1::uuid
      LIMIT 1`,
    [organizationId, actorId],
  );
  const business = result.rows[0];
  if (!business) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Business organization not found.' });
  }
  if (business.status !== 'ACTIVE' || !business.provider_enabled) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This business is not eligible to set up customer payments.',
    });
  }
  return {
    organizationId: business.organization_id,
    displayName: business.display_name,
    email: business.email,
  };
}

async function loadLocalAccount(
  query: QueryFn,
  organizationId: string,
  environment: TilledEnvironment,
): Promise<PaymentAccountRow | null> {
  const result = await query<PaymentAccountRow>(
    `SELECT ${paymentAccountColumns}
       FROM business_payment_accounts
      WHERE organization_id = $1::uuid
        AND provider = 'tilled'
        AND environment = $2::text
      LIMIT 1`,
    [organizationId, environment],
  );
  return result.rows[0] ?? null;
}

function capabilityFor(
  account: TilledConnectedAccount,
  pricingTemplateId: string,
) {
  return account.capabilities.find(
    (capability) => capability.pricing_template?.id === pricingTemplateId,
  );
}

function safeInvitationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function invitationActionFor(
  row: PaymentAccountRow,
): BusinessPaymentOnboardingResult['onboardingAction'] {
  if (row.invitation_state === 'CREATED') return 'check_email';
  if (row.invitation_state === 'NOT_CREATED'
    || row.invitation_state === 'CREATING'
    || row.invitation_state === 'RECONCILE_REQUIRED') return 'create_invitation';
  return 'none';
}

export function mapTilledOnboardingStatus(status: TilledOnboardingStatus): {
  localStatus: LocalAccountStatus;
  chargesEnabled: boolean;
  status: BusinessPaymentSetupStatus;
} {
  switch (status) {
    case 'active':
      return { localStatus: 'ACTIVE', chargesEnabled: true, status: 'active' };
    case 'submitted':
      return { localStatus: 'PENDING', chargesEnabled: false, status: 'submitted' };
    case 'in_review':
      return { localStatus: 'IN_REVIEW', chargesEnabled: false, status: 'under_review' };
    case 'rejected':
      return { localStatus: 'REJECTED', chargesEnabled: false, status: 'rejected' };
    case 'disabled':
      return { localStatus: 'DISABLED', chargesEnabled: false, status: 'disabled' };
    case 'withdrawn':
      return { localStatus: 'WITHDRAWN', chargesEnabled: false, status: 'withdrawn' };
    case 'created':
    case 'started':
      return { localStatus: 'PENDING', chargesEnabled: false, status: 'action_required' };
  }
}

function serializeLocal(
  row: PaymentAccountRow | null,
  environment: TilledEnvironment,
): BusinessPaymentOnboardingResult {
  if (!row) {
    return {
      organizationId: '',
      environment,
      status: 'not_started',
      providerStatus: null,
      chargesEnabled: false,
      onboardingAction: 'none',
    };
  }
  if (row.onboarding_state === 'RECONCILE_REQUIRED' || row.onboarding_state === 'CREATING') {
    return {
      organizationId: row.organization_id,
      environment,
      status: 'reconciliation_required',
      providerStatus: row.provider_onboarding_status,
      chargesEnabled: false,
      onboardingAction: 'none',
    };
  }
  if (!row.provider_onboarding_status) {
    if (row.status === 'ACTIVE' && row.charges_enabled) {
      return {
        organizationId: row.organization_id,
        environment,
        status: 'active',
        providerStatus: null,
        chargesEnabled: true,
        onboardingAction: 'none',
      };
    }
    return {
      organizationId: row.organization_id,
      environment,
      status: row.onboarding_state === 'RESERVED' ? 'not_started' : 'action_required',
      providerStatus: null,
      chargesEnabled: false,
      onboardingAction: row.onboarding_state === 'RESERVED'
        ? 'none'
        : invitationActionFor(row),
    };
  }
  const mapped = mapTilledOnboardingStatus(row.provider_onboarding_status);
  return {
    organizationId: row.organization_id,
    environment,
    status: mapped.status,
    providerStatus: row.provider_onboarding_status,
    chargesEnabled: row.charges_enabled && mapped.chargesEnabled,
    onboardingAction: mapped.status === 'action_required'
      ? invitationActionFor(row)
      : 'none',
  };
}

async function persistProviderAccount(
  rowId: string,
  account: TilledConnectedAccount,
  environment: TilledEnvironment,
  pricingTemplateId: string,
): Promise<PaymentAccountRow> {
  const capability = capabilityFor(account, pricingTemplateId);
  if (!capability) {
    throw new TilledApiError('INVALID_PROVIDER_RESPONSE', undefined, { kind: 'invalid_response' });
  }
  const mapped = mapTilledOnboardingStatus(capability.status);
  const result = await db.query<PaymentAccountRow>(
    `UPDATE business_payment_accounts
        SET provider_account_id = $2::text,
            application_id = $3::text,
            status = $4::text,
            charges_enabled = $5::boolean,
            provider_onboarding_status = $6::text,
            onboarding_state = 'BOUND',
            last_synced_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING ${paymentAccountColumns}`,
    [rowId, account.id, capability.id, mapped.localStatus, mapped.chargesEnabled, capability.status],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Tilled merchant account binding was not persisted.');
  logger.info({
    operation: 'tilled_merchant_onboarding',
    stage: 'persist_provider_account',
    organization_id: row.organization_id,
    provider_account_id: account.id,
    provider_application_id: capability.id,
    provider_status: capability.status,
    environment,
  }, 'Tilled merchant onboarding state persisted');
  return row;
}

async function reconcileAccount(
  row: PaymentAccountRow,
  client: TilledClient,
  config: ReturnType<typeof loadTilledOnboardingConfig>,
): Promise<PaymentAccountRow> {
  const matches = await client.findConnectedAccountsByMetadata({
    platformAccountId: config.platformAccountId,
    metadata: onboardingMetadata(row.organization_id, config.environment),
  });
  if (matches.length !== 1) {
    await db.query(
      `UPDATE business_payment_accounts
          SET onboarding_state = 'RECONCILE_REQUIRED', updated_at = NOW()
        WHERE id = $1::uuid`,
      [row.id],
    );
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: matches.length > 1
        ? 'Payment setup needs support review before it can continue.'
        : 'Payment setup is still being reconciled. Please retry shortly.',
    });
  }
  return persistProviderAccount(row.id, matches[0], config.environment, config.defaultPricingTemplateId);
}

function serializeInvitation(
  row: PaymentAccountRow,
  environment: TilledEnvironment,
  invitation: TilledUserInvitation,
): BusinessPaymentOnboardingResult {
  const invitationUrl = new Date(invitation.expires_at).getTime() > Date.now()
    ? safeInvitationUrl(invitation.invitation_url)
    : undefined;
  return {
    ...serializeLocal(row, environment),
    onboardingAction: invitationUrl ? 'open_invitation' : 'check_email',
    ...(invitationUrl ? { invitationUrl } : {}),
  };
}

async function persistUserInvitation(
  row: PaymentAccountRow,
  invitation: TilledUserInvitation,
  environment: TilledEnvironment,
): Promise<BusinessPaymentOnboardingResult> {
  const result = await db.query<PaymentAccountRow>(
    `UPDATE business_payment_accounts
        SET provider_user_invitation_id = $2::text,
            invitation_state = 'CREATED',
            invitation_email = $3::text,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND provider_account_id = $4::text
        AND invitation_state = 'CREATING'
      RETURNING ${paymentAccountColumns}`,
    [row.id, invitation.id, invitation.email, row.provider_account_id],
  );
  const persisted = result.rows[0];
  if (!persisted) {
    throw new Error('Tilled merchant invitation binding was not persisted.');
  }
  logger.info({
    operation: 'tilled_merchant_onboarding',
    stage: 'persist_user_invitation',
    organization_id: persisted.organization_id,
    provider_account_id: persisted.provider_account_id,
    provider_user_invitation_id: invitation.id,
    invitation_delivery: invitation.invitation_url ? 'url_and_email' : 'email',
    environment,
  }, 'Tilled merchant invitation persisted');
  return serializeInvitation(persisted, environment, invitation);
}

async function ensureMerchantInvitation(
  row: PaymentAccountRow,
  business: BusinessContext,
  client: TilledClient,
  config: ReturnType<typeof loadTilledOnboardingConfig>,
): Promise<BusinessPaymentOnboardingResult> {
  if (row.status === 'ACTIVE' && row.charges_enabled) {
    return serializeLocal(row, config.environment);
  }

  if (row.invitation_state === 'CREATED' && row.provider_user_invitation_id) {
    try {
      const invitation = await client.getUserInvitation(
        row.provider_account_id,
        row.provider_user_invitation_id,
      );
      return serializeInvitation(row, config.environment, invitation);
    } catch (error) {
      if (error instanceof TilledApiError && error.httpStatus === 404) {
        return {
          ...serializeLocal(row, config.environment),
          onboardingAction: 'check_email',
        };
      }
      throw error;
    }
  }

  if (row.invitation_state === 'CREATING') {
    const recoverable = await db.query<PaymentAccountRow>(
      `UPDATE business_payment_accounts
          SET invitation_state = 'RECONCILE_REQUIRED', updated_at = NOW()
        WHERE id = $1::uuid
          AND invitation_state = 'CREATING'
          AND updated_at < NOW() - INTERVAL '30 seconds'
        RETURNING ${paymentAccountColumns}`,
      [row.id],
    );
    if (recoverable.rows[0]) {
      return ensureMerchantInvitation(
        recoverable.rows[0],
        business,
        client,
        config,
      );
    }
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The payment setup invitation is still being prepared. Please retry shortly.',
    });
  }

  const claimed = await db.query<PaymentAccountRow>(
    `UPDATE business_payment_accounts
        SET invitation_state = 'CREATING',
            invitation_email = $2::text,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND provider_account_id = $3::text
        AND invitation_state IN ('NOT_CREATED', 'RECONCILE_REQUIRED')
      RETURNING ${paymentAccountColumns}`,
    [row.id, business.email, row.provider_account_id],
  );
  const claimedRow = claimed.rows[0];
  if (!claimedRow) {
    const current = await loadLocalAccount(db.query, row.organization_id, config.environment);
    if (!current || current.id !== row.id) {
      throw new Error('Tilled merchant account changed while preparing its invitation.');
    }
    return ensureMerchantInvitation(current, business, client, config);
  }

  logger.info({
    operation: 'tilled_merchant_onboarding',
    stage: 'create_user_invitation',
    organization_id: row.organization_id,
    provider_account_id: row.provider_account_id,
    environment: config.environment,
  }, 'Preparing Tilled merchant application invitation');

  try {
    const matches = await client.findUserInvitations({
      accountId: row.provider_account_id,
      email: business.email,
    });
    const invitation = matches[0] ?? await client.createUserInvitation({
      accountId: row.provider_account_id,
      email: business.email,
    });
    return await persistUserInvitation(claimedRow, invitation, config.environment);
  } catch (error) {
    const deterministicRejection = error instanceof TilledApiError
      && error.httpStatus !== undefined
      && error.httpStatus >= 400
      && error.httpStatus < 500
      && error.httpStatus !== 409
      && error.httpStatus !== 429;
    await db.query(
      `UPDATE business_payment_accounts
          SET invitation_state = $2::text, updated_at = NOW()
        WHERE id = $1::uuid AND invitation_state = 'CREATING'`,
      [row.id, deterministicRejection ? 'NOT_CREATED' : 'RECONCILE_REQUIRED'],
    );
    logger.warn({
      operation: 'tilled_merchant_onboarding',
      stage: 'create_user_invitation',
      organization_id: row.organization_id,
      provider_account_id: row.provider_account_id,
      environment: config.environment,
      outcome: deterministicRejection ? 'deterministic_rejection' : 'reconciliation_required',
      http_status: error instanceof TilledApiError ? error.httpStatus : undefined,
      provider_error_code: error instanceof TilledApiError ? error.code : undefined,
      provider_error_type: error instanceof TilledApiError
        ? error.details.providerErrorType
        : undefined,
      correlation_id: error instanceof TilledApiError
        ? error.details.correlationId
        : undefined,
      error_name: error instanceof Error ? error.name : 'unknown',
    }, 'Tilled merchant invitation creation failed');
    throw error;
  }
}

function isRealProviderAccount(accountId: string): boolean {
  return /^acct_[A-Za-z0-9_]+$/.test(accountId);
}

export async function getBusinessPaymentOnboardingStatus(input: {
  organizationId: string;
  actorId: string;
}): Promise<BusinessPaymentOnboardingResult> {
  await authorizeAndLoadBusiness(db.query, input.organizationId, input.actorId);
  const config = loadTilledOnboardingConfig();
  const row = await loadLocalAccount(db.query, input.organizationId, config.environment);
  return {
    ...serializeLocal(row, config.environment),
    organizationId: input.organizationId,
  };
}

export async function refreshBusinessPaymentOnboarding(input: {
  organizationId: string;
  actorId: string;
}): Promise<BusinessPaymentOnboardingResult> {
  await authorizeAndLoadBusiness(db.query, input.organizationId, input.actorId);
  const config = loadTilledOnboardingConfig();
  const row = await loadLocalAccount(db.query, input.organizationId, config.environment);
  if (!row) return { ...serializeLocal(null, config.environment), organizationId: input.organizationId };
  const client = new TilledClient(config);
  if (!isRealProviderAccount(row.provider_account_id)) {
    if (row.onboarding_state === 'RESERVED') return serializeLocal(row, config.environment);
    const reconciled = await reconcileAccount(row, client, config);
    return serializeLocal(reconciled, config.environment);
  }
  const account = await client.getConnectedAccount(row.provider_account_id);
  const persisted = await persistProviderAccount(
    row.id,
    account,
    config.environment,
    config.defaultPricingTemplateId,
  );
  return serializeLocal(persisted, config.environment);
}

export async function startBusinessPaymentOnboarding(input: {
  organizationId: string;
  actorId: string;
}): Promise<BusinessPaymentOnboardingResult> {
  let config!: ReturnType<typeof loadTilledOnboardingConfig>;
  const prepared = await db.transaction(async (query) => {
    const business = await authorizeAndLoadBusiness(query, input.organizationId, input.actorId);
    config = loadTilledOnboardingConfig();
    await query(
      `INSERT INTO business_payment_accounts (
         organization_id, provider, environment, provider_account_id, status,
         charges_enabled, metadata, onboarding_state
       ) VALUES ($1::uuid, 'tilled', $2::text, $3::text, 'PENDING', FALSE, $4::jsonb, 'RESERVED')
       ON CONFLICT (organization_id, provider, environment) DO NOTHING`,
      [
        input.organizationId,
        config.environment,
        reservationAccountId(input.organizationId, config.environment),
        JSON.stringify(onboardingMetadata(input.organizationId, config.environment)),
      ],
    );
    const row = await loadLocalAccount(query, input.organizationId, config.environment);
    if (!row) throw new Error('Payment onboarding reservation was not created.');
    if (row.onboarding_state === 'RESERVED') {
      const claimed = await query<PaymentAccountRow>(
        `UPDATE business_payment_accounts
            SET onboarding_state = 'CREATING', updated_at = NOW()
          WHERE id = $1::uuid AND onboarding_state = 'RESERVED'
          RETURNING ${paymentAccountColumns}`,
        [row.id],
      );
      return { business, row: claimed.rows[0] ?? row, create: claimed.rowCount === 1 };
    }
    return { business, row, create: false };
  });

  logger.info({
    operation: 'tilled_merchant_onboarding',
    stage: 'reserve_local_account',
    organization_id: input.organizationId,
    local_payment_account_id: prepared.row.id,
    onboarding_state: prepared.row.onboarding_state,
    create_provider_account: prepared.create,
    environment: config.environment,
  }, 'Tilled merchant onboarding reservation resolved');

  const client = new TilledClient(config);
  if (!prepared.create) {
    if (isRealProviderAccount(prepared.row.provider_account_id)) {
      const account = await client.getConnectedAccount(prepared.row.provider_account_id);
      const persisted = await persistProviderAccount(
        prepared.row.id,
        account,
        config.environment,
        config.defaultPricingTemplateId,
      );
      return ensureMerchantInvitation(persisted, prepared.business, client, config);
    }
    const reconciled = await reconcileAccount(prepared.row, client, config);
    return ensureMerchantInvitation(reconciled, prepared.business, client, config);
  }

  logger.info({
    operation: 'tilled_merchant_onboarding',
    stage: 'create_connected_account',
    organization_id: input.organizationId,
    environment: config.environment,
  }, 'Creating Tilled connected merchant account');

  let account: TilledConnectedAccount;
  try {
    account = await client.createConnectedAccount({
      platformAccountId: config.platformAccountId,
      email: prepared.business.email,
      name: prepared.business.displayName,
      pricingTemplateId: config.defaultPricingTemplateId,
      metadata: onboardingMetadata(input.organizationId, config.environment),
    });
  } catch (error) {
    const deterministicRejection = error instanceof TilledApiError
      && error.httpStatus !== undefined
      && error.httpStatus >= 400
      && error.httpStatus < 500
      && error.httpStatus !== 409
      && error.httpStatus !== 429;
    await db.query(
      `UPDATE business_payment_accounts
          SET onboarding_state = $2::text, updated_at = NOW()
        WHERE id = $1::uuid AND onboarding_state = 'CREATING'`,
      [prepared.row.id, deterministicRejection ? 'RESERVED' : 'RECONCILE_REQUIRED'],
    );
    logger.warn({
      operation: 'tilled_merchant_onboarding',
      stage: 'create_connected_account',
      organization_id: input.organizationId,
      environment: config.environment,
      outcome: deterministicRejection ? 'deterministic_rejection' : 'reconciliation_required',
      http_status: error instanceof TilledApiError ? error.httpStatus : undefined,
      provider_error_code: error instanceof TilledApiError ? error.code : undefined,
      provider_error_type: error instanceof TilledApiError
        ? error.details.providerErrorType
        : undefined,
      correlation_id: error instanceof TilledApiError
        ? error.details.correlationId
        : undefined,
      error_name: error instanceof Error ? error.name : 'unknown',
    }, 'Tilled connected merchant account creation failed');
    throw error;
  }

  const persisted = await persistProviderAccount(
    prepared.row.id,
    account,
    config.environment,
    config.defaultPricingTemplateId,
  );
  return ensureMerchantInvitation(persisted, prepared.business, client, config);
}
