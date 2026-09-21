import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

const { TilledClient } = await import('../../src/services/payment/TilledClient.js');
const { TilledApiError } = await import('../../src/services/payment/TilledClient.js');
const { db } = await import('../../src/db.js');
const { loadTilledOnboardingConfig } = await import('../../src/services/payment/TilledConfig.js');
const { mapTilledOnboardingStatus } = await import(
  '../../src/services/payment/TilledMerchantOnboardingService.js'
);
const { startBusinessPaymentOnboarding, refreshBusinessPaymentOnboarding } = await import(
  '../../src/services/payment/TilledMerchantOnboardingService.js'
);
const { BusinessPaymentOrganizationInput } = await import(
  '../../src/routers/businessPayment.js'
);

const config = {
  environment: 'sandbox' as const,
  apiBaseUrl: 'https://sandbox-api.tilled.com',
  secretKey: 'test-secret',
  publishableKey: 'test-public',
  platformAccountId: 'acct_platform',
  defaultPricingTemplateId: 'pt_card',
};

const account = {
  id: 'acct_merchant',
  email: 'owner@example.com',
  name: 'Example Business',
  metadata: {
    hustlexp_organization_id: 'organization-one',
    hustlexp_environment: 'sandbox',
  },
  capabilities: [{
    id: 'cap_application',
    status: 'created',
    onboarding_application_url: 'https://onboarding.tilled.com/application',
    pricing_template: { id: 'pt_card', payment_method_type: 'card' },
  }],
};

const invitation = {
  id: 'ui_merchant_owner',
  account_id: 'acct_merchant',
  email: 'owner@example.com',
  role: 'admin',
  created_at: '2026-09-21T00:00:00.000Z',
  updated_at: '2026-09-21T00:00:00.000Z',
  expires_at: '2099-09-28T00:00:00.000Z',
  sent_at: '2026-09-21T00:00:00.000Z',
  invitation_url: 'https://sandbox-app.tilled.com/user-invitations/ui_merchant_owner',
};

const organizationId = 'c7eaefe5-2f45-4ddf-8ac1-0d1a23ef4fd3';
const actorId = 'b355def1-8453-44bc-87e8-b216705ceb81';
const paymentAccountId = 'b39e8183-82ca-4d04-86ac-70deedbbc306';
const reservedRow = {
  id: paymentAccountId,
  organization_id: organizationId,
  provider_account_id: `tilled_onboarding:${organizationId}:sandbox`,
  application_id: null,
  status: 'PENDING',
  charges_enabled: false,
  provider_onboarding_status: null,
  onboarding_state: 'RESERVED',
  provider_user_invitation_id: null,
  invitation_state: 'NOT_CREATED',
  invitation_email: null,
  last_synced_at: null,
  updated_at: new Date(),
};

beforeEach(() => {
  vi.mocked(db.query).mockReset();
  vi.mocked(db.transaction).mockReset();
  vi.stubEnv('TILLED_ENV', 'sandbox');
  vi.stubEnv('TILLED_SECRET_KEY', 'test-secret');
  vi.stubEnv('TILLED_PUBLISHABLE_KEY', 'test-public');
  vi.stubEnv('TILLED_PLATFORM_ACCOUNT_ID', 'acct_platform');
  vi.stubEnv('TILLED_DEFAULT_PRICING_TEMPLATE_ID', 'pt_card');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function prepareTransaction(row = reservedRow) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{
      organization_id: organizationId,
      display_name: 'Example Business',
      email: 'owner@example.com',
      status: 'ACTIVE',
      provider_enabled: true,
    }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 });
  vi.mocked(db.transaction).mockImplementation(async (callback) => callback(query as never));
  return query;
}

describe('Tilled merchant onboarding contract', () => {
  it('requires server-side platform and pricing configuration', () => {
    expect(() => loadTilledOnboardingConfig({
      TILLED_ENV: 'sandbox',
      TILLED_SECRET_KEY: 'secret',
      TILLED_PUBLISHABLE_KEY: 'public',
    })).toThrow('platform account');
    expect(loadTilledOnboardingConfig({
      TILLED_ENV: 'sandbox',
      TILLED_SECRET_KEY: 'secret',
      TILLED_PLATFORM_ACCOUNT_ID: 'acct_platform',
      TILLED_DEFAULT_PRICING_TEMPLATE_ID: 'pt_card',
    })).toMatchObject({
      environment: 'sandbox',
      platformAccountId: 'acct_platform',
      defaultPricingTemplateId: 'pt_card',
    });
  });

  it('accepts only an organization ID from the browser', () => {
    expect(BusinessPaymentOrganizationInput.safeParse({ organizationId }).success).toBe(true);
    expect(BusinessPaymentOrganizationInput.safeParse({
      organizationId,
      providerAccountId: 'acct_attacker_selected',
    }).success).toBe(false);
  });

  it('creates the connected account under the platform with server metadata and pricing', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(account), { status: 200 }),
    );
    const result = await new TilledClient(config, fetcher).createConnectedAccount({
      platformAccountId: config.platformAccountId,
      email: account.email,
      name: account.name,
      pricingTemplateId: config.defaultPricingTemplateId,
      metadata: account.metadata,
    });
    expect(result.id).toBe('acct_merchant');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://sandbox-api.tilled.com/v1/accounts/connected');
    expect(init.headers['tilled-account']).toBe('acct_platform');
    expect(JSON.parse(init.body)).toEqual({
      email: account.email,
      name: account.name,
      pricing_template_ids: ['pt_card'],
      metadata: account.metadata,
    });
  });

  it('reads current account state using the merchant account header', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(account), { status: 200 }),
    );
    await new TilledClient(config, fetcher).getConnectedAccount('acct_merchant');
    expect(fetcher.mock.calls[0][0]).toBe('https://sandbox-api.tilled.com/v1/accounts');
    expect(fetcher.mock.calls[0][1].headers['tilled-account']).toBe('acct_merchant');
  });

  it('creates the documented merchant application invitation on the connected account', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(invitation), { status: 201 }),
    );
    const result = await new TilledClient(config, fetcher).createUserInvitation({
      accountId: account.id,
      email: invitation.email,
    });
    expect(result.invitation_url).toBe(invitation.invitation_url);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://sandbox-api.tilled.com/v1/user-invitations');
    expect(init.headers['tilled-account']).toBe('acct_merchant');
    expect(JSON.parse(init.body)).toEqual({
      email: invitation.email,
      email_template: 'merchant_application',
      role: 'admin',
    });
  });

  it('recovers only the exact organization and environment metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [account, {
        ...account,
        id: 'acct_other',
        metadata: { ...account.metadata, hustlexp_organization_id: 'organization-other' },
      }],
    }), { status: 200 }));
    const found = await new TilledClient(config, fetcher).findConnectedAccountsByMetadata({
      platformAccountId: 'acct_platform',
      metadata: account.metadata,
    });
    expect(found.map((item) => item.id)).toEqual(['acct_merchant']);
  });

  it.each([
    ['created', 'action_required', false],
    ['started', 'action_required', false],
    ['submitted', 'submitted', false],
    ['in_review', 'under_review', false],
    ['active', 'active', true],
    ['rejected', 'rejected', false],
    ['disabled', 'disabled', false],
    ['withdrawn', 'withdrawn', false],
  ] as const)('maps %s to %s with charges=%s', (providerStatus, status, chargesEnabled) => {
    expect(mapTilledOnboardingStatus(providerStatus)).toMatchObject({ status, chargesEnabled });
  });
});

describe('Tilled merchant onboarding idempotency', () => {
  it('checks billing authority, creates once, and binds the provider identity', async () => {
    const query = prepareTransaction();
    query.mockResolvedValueOnce({
      rows: [{ ...reservedRow, onboarding_state: 'CREATING' }],
      rowCount: 1,
    });
    vi.spyOn(TilledClient.prototype, 'createConnectedAccount').mockResolvedValue(account as never);
    vi.spyOn(TilledClient.prototype, 'findUserInvitations').mockResolvedValue([]);
    vi.spyOn(TilledClient.prototype, 'createUserInvitation').mockResolvedValue(invitation as never);
    const boundRow = {
      ...reservedRow,
      provider_account_id: account.id,
      application_id: 'cap_application',
      provider_onboarding_status: 'created',
      onboarding_state: 'BOUND',
    } as const;
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [boundRow],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ ...boundRow, invitation_state: 'CREATING' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          ...boundRow,
          provider_user_invitation_id: invitation.id,
          invitation_state: 'CREATED',
          invitation_email: invitation.email,
        }],
        rowCount: 1,
      } as never);

    const result = await startBusinessPaymentOnboarding({ organizationId, actorId });
    expect(query.mock.calls[0][0]).toContain('MANAGE_BILLING');
    expect(TilledClient.prototype.createConnectedAccount).toHaveBeenCalledOnce();
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([
      paymentAccountId,
      'acct_merchant',
      'cap_application',
      'PENDING',
      false,
      'created',
    ]);
    expect(result).toMatchObject({
      organizationId,
      status: 'action_required',
      chargesEnabled: false,
      onboardingAction: 'open_invitation',
      invitationUrl: invitation.invitation_url,
    });
    expect(result).not.toHaveProperty('onboardingUrl');
    expect(TilledClient.prototype.createUserInvitation).toHaveBeenCalledWith({
      accountId: 'acct_merchant',
      email: 'owner@example.com',
    });
    expect(vi.mocked(db.query).mock.calls[2][1]).toEqual([
      paymentAccountId,
      invitation.id,
      invitation.email,
      account.id,
    ]);
  });

  it('resumes the same connected account and invitation without creating duplicates', async () => {
    const boundRow = {
      ...reservedRow,
      provider_account_id: 'acct_merchant',
      application_id: 'cap_application',
      provider_onboarding_status: 'started',
      onboarding_state: 'BOUND',
      provider_user_invitation_id: invitation.id,
      invitation_state: 'CREATED',
      invitation_email: invitation.email,
    };
    prepareTransaction(boundRow);
    const createAccount = vi.spyOn(TilledClient.prototype, 'createConnectedAccount');
    const createInvitation = vi.spyOn(TilledClient.prototype, 'createUserInvitation');
    vi.spyOn(TilledClient.prototype, 'getConnectedAccount').mockResolvedValue({
      ...account,
      capabilities: [{ ...account.capabilities[0], status: 'started' }],
    } as never);
    vi.spyOn(TilledClient.prototype, 'getUserInvitation').mockResolvedValue(invitation as never);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [boundRow], rowCount: 1 } as never);

    const result = await startBusinessPaymentOnboarding({ organizationId, actorId });
    expect(createAccount).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      organizationId,
      status: 'action_required',
      onboardingAction: 'open_invitation',
      invitationUrl: invitation.invitation_url,
    });
  });

  it('represents an email-only merchant invitation without returning a console URL', async () => {
    const boundRow = {
      ...reservedRow,
      provider_account_id: account.id,
      application_id: 'cap_application',
      provider_onboarding_status: 'created',
      onboarding_state: 'BOUND',
      provider_user_invitation_id: invitation.id,
      invitation_state: 'CREATED',
      invitation_email: invitation.email,
    } as const;
    prepareTransaction(boundRow);
    vi.spyOn(TilledClient.prototype, 'getConnectedAccount').mockResolvedValue(account as never);
    vi.spyOn(TilledClient.prototype, 'getUserInvitation').mockResolvedValue({
      ...invitation,
      invitation_url: undefined,
    } as never);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [boundRow], rowCount: 1 } as never);

    const result = await startBusinessPaymentOnboarding({ organizationId, actorId });
    expect(result).toMatchObject({
      status: 'action_required',
      onboardingAction: 'check_email',
    });
    expect(result).not.toHaveProperty('invitationUrl');
    expect(result).not.toHaveProperty('onboardingUrl');
  });

  it('recovers an existing provider invitation instead of creating a duplicate', async () => {
    const boundRow = {
      ...reservedRow,
      provider_account_id: account.id,
      application_id: 'cap_application',
      provider_onboarding_status: 'created',
      onboarding_state: 'BOUND',
      invitation_state: 'RECONCILE_REQUIRED',
    } as const;
    prepareTransaction(boundRow);
    vi.spyOn(TilledClient.prototype, 'getConnectedAccount').mockResolvedValue(account as never);
    vi.spyOn(TilledClient.prototype, 'findUserInvitations').mockResolvedValue([invitation] as never);
    const createInvitation = vi.spyOn(TilledClient.prototype, 'createUserInvitation');
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [boundRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{ ...boundRow, invitation_state: 'CREATING' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          ...boundRow,
          provider_user_invitation_id: invitation.id,
          invitation_state: 'CREATED',
          invitation_email: invitation.email,
        }],
        rowCount: 1,
      } as never);

    const result = await startBusinessPaymentOnboarding({ organizationId, actorId });
    expect(createInvitation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      onboardingAction: 'open_invitation',
      invitationUrl: invitation.invitation_url,
    });
  });

  it('does not call Tilled when billing authority is denied', async () => {
    const query = vi.fn().mockRejectedValue(new Error('business permission denied'));
    vi.mocked(db.transaction).mockImplementation(async (callback) => callback(query as never));
    const create = vi.spyOn(TilledClient.prototype, 'createConnectedAccount');
    await expect(startBusinessPaymentOnboarding({ organizationId, actorId }))
      .rejects.toThrow('business permission denied');
    expect(create).not.toHaveBeenCalled();
  });

  it('marks timeout creation as ambiguous and recovers by exact metadata', async () => {
    const first = prepareTransaction();
    first.mockResolvedValueOnce({
      rows: [{ ...reservedRow, onboarding_state: 'CREATING' }],
      rowCount: 1,
    });
    const create = vi.spyOn(TilledClient.prototype, 'createConnectedAccount')
      .mockRejectedValue(new TilledApiError('PROVIDER_TIMEOUT', undefined, { kind: 'timeout' }));
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(startBusinessPaymentOnboarding({ organizationId, actorId }))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([
      paymentAccountId,
      'RECONCILE_REQUIRED',
    ]);

    const reconcileRow = { ...reservedRow, onboarding_state: 'RECONCILE_REQUIRED' };
    vi.mocked(db.query).mockReset();
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{
        organization_id: organizationId,
        display_name: 'Example Business',
        email: 'owner@example.com',
        status: 'ACTIVE',
        provider_enabled: true,
      }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [reconcileRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{
        ...reconcileRow,
        provider_account_id: account.id,
        application_id: 'cap_application',
        provider_onboarding_status: 'created',
        onboarding_state: 'BOUND',
      }], rowCount: 1 } as never);
    vi.spyOn(TilledClient.prototype, 'findConnectedAccountsByMetadata')
      .mockResolvedValue([account] as never);

    const recovered = await refreshBusinessPaymentOnboarding({ organizationId, actorId });
    expect(recovered.status).toBe('action_required');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('classifies a provider 4xx as deterministic and leaves the reservation retryable', async () => {
    const query = prepareTransaction();
    query.mockResolvedValueOnce({
      rows: [{ ...reservedRow, onboarding_state: 'CREATING' }],
      rowCount: 1,
    });
    vi.spyOn(TilledClient.prototype, 'createConnectedAccount').mockRejectedValue(
      new TilledApiError('invalid_business', 422, { kind: 'provider_rejected' }),
    );
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(startBusinessPaymentOnboarding({ organizationId, actorId }))
      .rejects.toMatchObject({ code: 'invalid_business', httpStatus: 422 });
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([
      paymentAccountId,
      'RESERVED',
    ]);
  });

  it('refreshes an active provider account and enables charges on the exact local row', async () => {
    const boundRow = {
      ...reservedRow,
      provider_account_id: 'acct_merchant',
      application_id: 'cap_application',
      provider_onboarding_status: 'submitted',
      onboarding_state: 'BOUND',
    };
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{
        organization_id: organizationId,
        display_name: 'Example Business',
        email: 'owner@example.com',
        status: 'ACTIVE',
        provider_enabled: true,
      }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [boundRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{
        ...boundRow,
        status: 'ACTIVE',
        charges_enabled: true,
        provider_onboarding_status: 'active',
      }], rowCount: 1 } as never);
    vi.spyOn(TilledClient.prototype, 'getConnectedAccount').mockResolvedValue({
      ...account,
      capabilities: [{ ...account.capabilities[0], status: 'active' }],
    } as never);

    const result = await refreshBusinessPaymentOnboarding({ organizationId, actorId });
    expect(result).toMatchObject({ status: 'active', chargesEnabled: true });
    expect(vi.mocked(db.query).mock.calls[3][1]).toEqual([
      paymentAccountId,
      'acct_merchant',
      'cap_application',
      'ACTIVE',
      true,
      'active',
    ]);
  });
});
