import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

import { UniversalV1TaskOpportunityService } from '../../src/services/UniversalV1TaskOpportunityService';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CELL_ID = '22222222-2222-4222-8222-222222222222';
const OPPORTUNITY_ID = '33333333-3333-4333-8333-333333333333';
const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '55555555-5555-4555-8555-555555555555';
const ORIGIN_ID = '66666666-6666-4666-8666-666666666666';
const ORGANIZATION_ID = '77777777-7777-4777-8777-777777777777';
const CREDENTIAL_ID = '88888888-8888-4888-8888-888888888888';
const INTEREST_ID = '99999999-9999-4999-8999-999999999999';
const ELIGIBILITY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STANDARDIZED_QUOTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const context = {
  user: {
    id: USER_ID,
    is_banned: false,
    account_status: 'ACTIVE',
    default_mode: 'worker',
  },
  firebaseUid: 'firebase-provider',
} as any;

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

function generalAuthority(overrides: Record<string, unknown> = {}) {
  return {
    account_status: 'ACTIVE',
    is_minor: false,
    is_banned: false,
    profile_provider_class: 'GENERAL_SERVICE_PROVIDER',
    profile_updated_at: new Date('2026-08-30T10:00:00.000Z'),
    organization_provider_class: null,
    organization_status: null,
    organization_verification_status: null,
    organization_provider_enabled: null,
    active_membership: false,
    current_trade_credential: false,
    ...overrides,
  };
}

function opportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    opportunity_id: OPPORTUNITY_ID,
    opportunity_version: 1,
    task_draft_id: DRAFT_ID,
    routing_decision_id: ROUTE_ID,
    routing_decision_version: 1,
    routing_policy_version: 'universal-v1-intake-1.2.0',
    relationship_origin_id: ORIGIN_ID,
    relationship_origin_version: 1,
    relationship_origin_kind: 'MARKETPLACE',
    relationship_origin_policy_version: 1,
    scope_artifact_kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1',
    scope_artifact_id: ROUTE_ID,
    scope_artifact_version: 1,
    scope_artifact_sha256: 'a'.repeat(64),
    public_scope: {
      contractVersion: 1,
      workCategoryCode: 'furniture_assembly',
      roughLocation: 'North district',
    },
    work_category_code: 'furniture_assembly',
    service_cell_authority_id: CELL_ID,
    service_cell_authority_version: 2,
    service_cell_evidence_sha256: 'b'.repeat(64),
    region_code: 'US-CA',
    rough_location: 'North district',
    risk_level: 'LOW',
    requires_proof: true,
    routing_outcome: 'FULFILLMENT_CANDIDATE',
    routed_at: new Date('2026-08-30T11:00:00.000Z'),
    privacy_posture: 'ROUTE_CONTEXT_ALLOWLIST_ONLY',
    eligibility_posture: 'HELD_PENDING_TASK_SPECIFIC_EVALUATION',
    assignment_authority: 'NONE',
    address_contact_authority: 'NONE',
    financial_authority: 'NONE',
    guaranteed_earning_authority: 'NONE',
    standardized_quote_id: STANDARDIZED_QUOTE_ID,
    standardized_quote_version: 1,
    standardized_quote_sha256: 'f'.repeat(64),
    standardized_scope_artifact_kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
    standardized_scope_artifact_id: STANDARDIZED_QUOTE_ID,
    standardized_scope_artifact_version: 1,
    standardized_scope_artifact_sha256: '9'.repeat(64),
    customer_total_cents: 12_000,
    currency: 'usd',
    fake_payment_method_ready: true,
    payment_method_readiness_posture: 'FAKE_PAYMENT_METHOD_READY_NO_FINANCIAL_EFFECT',
    ...overrides,
  };
}

function estimateOpportunityRow() {
  return opportunityRow({
    routing_outcome: 'ESTIMATE_REQUIRED',
    standardized_quote_id: null,
    standardized_quote_version: null,
    standardized_quote_sha256: null,
    standardized_scope_artifact_kind: null,
    standardized_scope_artifact_id: null,
    standardized_scope_artifact_version: null,
    standardized_scope_artifact_sha256: null,
    customer_total_cents: null,
    currency: null,
    fake_payment_method_ready: false,
    payment_method_readiness_posture: 'NOT_APPLICABLE',
  });
}

function interestRow(
  requestDigest = 'c'.repeat(64),
  overrides: Record<string, unknown> = {}
) {
  return {
    interest_id: INTEREST_ID,
    opportunity_id: OPPORTUNITY_ID,
    opportunity_version: 1,
    task_draft_id: DRAFT_ID,
    routing_decision_id: ROUTE_ID,
    routing_decision_version: 1,
    routing_policy_version: 'universal-v1-intake-1.2.0',
    relationship_origin_id: ORIGIN_ID,
    relationship_origin_version: 1,
    scope_artifact_kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1',
    scope_artifact_id: ROUTE_ID,
    scope_artifact_version: 1,
    scope_artifact_sha256: 'a'.repeat(64),
    provider_class: 'GENERAL_SERVICE_PROVIDER',
    provider_binding_sha256: 'd'.repeat(64),
    provider_capability_sha256: 'e'.repeat(64),
    trade_qualification_sha256: null,
    work_category_code: 'furniture_assembly',
    service_cell_authority_id: CELL_ID,
    service_cell_authority_version: 2,
    region_code: 'US-CA',
    rough_location: 'North district',
    risk_level: 'LOW',
    requires_proof: true,
    routing_outcome: 'FULFILLMENT_CANDIDATE',
    status: 'pending',
    created_at: new Date('2026-08-30T12:00:00.000Z'),
    idempotency_key: 'interest:provider:0001',
    request_sha256: requestDigest,
    ...overrides,
  };
}

function journeyRow(overrides: Record<string, unknown> = {}) {
  return {
    ...interestRow(),
    routing_outcome: 'ESTIMATE_REQUIRED',
    opportunity_is_current: true,
    task_specific_provider_observation_current: true,
    eligibility_decision_id: null,
    eligibility_decision_version: null,
    eligibility_task_eligible: null,
    processor_payment_eligible: null,
    payout_funding_eligible: null,
    eligibility_valid_until: null,
    eligibility_is_current: false,
    invitation_id: null,
    invitation_quote_id: null,
    invitation_valid_until: null,
    invitation_is_current: false,
    expected_quote_version: null,
    ...overrides,
  };
}

function database(query: ReturnType<typeof vi.fn>) {
  return {
    query: query as any,
    transaction: async (fn: (transactionQuery: any) => Promise<unknown>) => fn(query),
  } as any;
}

describe('UniversalV1TaskOpportunityService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists redacted opportunities for a general individual without requiring a trade license', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([opportunityRow()]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    const response = await service.browse(context, {
      serviceCellAuthorityId: CELL_ID,
      limit: 50,
      offset: 0,
    });

    expect(response).toMatchObject({
      state: 'READY',
      providerClass: 'GENERAL_SERVICE_PROVIDER',
      selectedServiceCellAuthority: 'BROWSE_FILTER_ONLY',
      opportunities: [
        {
          opportunityId: OPPORTUNITY_ID,
          eligibilityStatus: 'PENDING',
          assignmentStatus: 'PENDING',
          financialAuthority: 'NONE',
          scopeArtifact: {
            kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
            id: STANDARDIZED_QUOTE_ID,
            version: 1,
            sha256: '9'.repeat(64),
          },
          interestScopeArtifact: {
            kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1',
            id: ROUTE_ID,
            version: 1,
            sha256: 'a'.repeat(64),
          },
          privacyPosture: 'STANDARDIZED_SCOPE_ALLOWLIST_ONLY',
          standardizedQuote: {
            quoteVersionId: STANDARDIZED_QUOTE_ID,
            customerTotalCents: 12_000,
            fakePaymentMethodReady: true,
            scopeArtifact: {
              kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
              id: STANDARDIZED_QUOTE_ID,
              version: 1,
              sha256: '9'.repeat(64),
            },
          },
        },
      ],
    });
    expect(query.mock.calls[1]![1]).toEqual([
      CELL_ID,
      null,
      'GENERAL_SERVICE_PROVIDER',
      USER_ID,
      null,
      null,
      50,
      0,
    ]);
    expect(JSON.stringify(response)).not.toMatch(
      /"(?:customer|customerId|customerName|email|phone|exactAddress|poster|posterId|posterUserId)"\s*:/iu
    );
  });

  it('holds browse when the provider capability observation is unresolved', async () => {
    const query = vi
      .fn()
      .mockResolvedValue(
        result([generalAuthority({ profile_provider_class: null, profile_updated_at: null })])
      );
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(
      service.browse(context, { serviceCellAuthorityId: CELL_ID, limit: 10, offset: 0 })
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'HELD',
        blockerCodes: ['PROVIDER_CAPABILITY_UNRESOLVED'],
        opportunities: [],
      })
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses exact current VTB credential observations only for the selected organization', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM public.users actor')) {
        return result([
          generalAuthority({
            profile_provider_class: 'VERIFIED_TRADE_BUSINESS',
            organization_provider_class: 'VERIFIED_TRADE_BUSINESS',
            organization_status: 'ACTIVE',
            organization_verification_status: 'VERIFIED',
            organization_provider_enabled: true,
            active_membership: true,
            current_trade_credential: true,
          }),
        ]);
      }
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([opportunityRow()]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    const response = await service.browse(context, {
      serviceCellAuthorityId: CELL_ID,
      providerOrganizationId: ORGANIZATION_ID,
      businessCredentialId: CREDENTIAL_ID,
      limit: 20,
      offset: 0,
    });
    expect(response).toMatchObject({ state: 'READY', providerClass: 'VERIFIED_TRADE_BUSINESS' });
    expect(String(query.mock.calls[1]![0])).toContain('current_verified_trade_qualifications');
    expect(query.mock.calls[1]![1]).toContain(CREDENTIAL_ID);
  });

  it('records only task_applications and returns every downstream effect false', async () => {
    const input = {
      opportunityId: OPPORTUNITY_ID,
      expectedOpportunityVersion: 1,
      idempotencyKey: 'interest:provider:0001',
    };
    const expectedDigest = createHash('sha256')
      .update(
        [
          'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
          USER_ID,
          OPPORTUNITY_ID,
          '1',
          '',
          '',
          input.idempotencyKey,
        ].join('|')
      )
      .digest('hex');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return result([]);
      if (sql.includes('AS active_provider_identity')) {
        return result([{ active_provider_identity: true }]);
      }
      if (sql.includes('application.idempotency_key = $2')) return result([]);
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([estimateOpportunityRow()]);
      }
      if (sql.includes('application.opportunity_id = $1::UUID')) return result([]);
      if (sql.includes('INSERT INTO public.task_applications')) {
        return result([
          interestRow(expectedDigest, { routing_outcome: 'ESTIMATE_REQUIRED' }),
        ]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    const response = await service.expressInterest(context, input);
    expect(response).toMatchObject({
      interestId: INTEREST_ID,
      idempotencyReplayed: false,
      eligibilityStatus: 'PENDING',
      assignmentStatus: 'PENDING',
      reservationCreated: false,
      eligibilityDecisionCreated: false,
      assignmentCreated: false,
      addressContactAccessGranted: false,
      financialEventCreated: false,
      payableCreated: false,
      guaranteedEarning: false,
    });
    const executedSql = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(executedSql).toContain('INSERT INTO public.task_applications');
    expect(executedSql).not.toMatch(
      /INSERT INTO public\.(?:tasks|task_provider_eligibility_decisions|task_reservations|task_work_orders|task_financial_security_events|provider_payables)/u
    );
  });

  it('records ready standardized fulfillment interest as observation only', async () => {
    const input = {
      opportunityId: OPPORTUNITY_ID,
      expectedOpportunityVersion: 1,
      idempotencyKey: 'interest:provider:held01',
    };
    const expectedDigest = createHash('sha256')
      .update([
        'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
        USER_ID,
        OPPORTUNITY_ID,
        '1',
        '',
        '',
        input.idempotencyKey,
      ].join('|'))
      .digest('hex');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return result([]);
      if (sql.includes('AS active_provider_identity')) {
        return result([{ active_provider_identity: true }]);
      }
      if (sql.includes('application.idempotency_key = $2')) return result([]);
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([opportunityRow()]);
      }
      if (sql.includes('application.opportunity_id = $1::UUID')) return result([]);
      if (sql.includes('INSERT INTO public.task_applications')) {
        return result([interestRow(expectedDigest)]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(service.expressInterest(context, input)).resolves.toMatchObject({
      interestId: INTEREST_ID,
      routing: { outcome: 'FULFILLMENT_CANDIDATE' },
      reservationCreated: false,
      eligibilityDecisionCreated: false,
      assignmentCreated: false,
      addressContactAccessGranted: false,
      financialEventCreated: false,
      payableCreated: false,
      guaranteedEarning: false,
    });

    const executedSql = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(executedSql).toContain('INSERT INTO public.task_applications');
    expect(executedSql).not.toMatch(
      /INSERT INTO public\.(?:tasks|task_provider_eligibility_decisions|task_reservations|task_work_orders|task_financial_security_events|provider_payables)/u
    );
  });

  it('holds fulfillment interest when exact standardized fake readiness is absent', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return result([]);
      if (sql.includes('AS active_provider_identity')) {
        return result([{ active_provider_identity: true }]);
      }
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([opportunityRow({
          fake_payment_method_ready: false,
          payment_method_readiness_posture: 'NOT_APPLICABLE',
        })]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(service.expressInterest(context, {
      opportunityId: OPPORTUNITY_ID,
      expectedOpportunityVersion: 1,
      idempotencyKey: 'interest:provider:unready1',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n'))
      .not.toContain('task_applications');
  });

  it('returns an exact concurrent replay only when the request digest matches', async () => {
    const input = {
      opportunityId: OPPORTUNITY_ID,
      expectedOpportunityVersion: 1,
      idempotencyKey: 'interest:provider:0001',
    };
    const digest = createHash('sha256')
      .update(
        [
          'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
          USER_ID,
          OPPORTUNITY_ID,
          '1',
          '',
          '',
          input.idempotencyKey,
        ].join('|')
      )
      .digest('hex');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return result([]);
      if (sql.includes('AS active_provider_identity')) {
        return result([{ active_provider_identity: true }]);
      }
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([estimateOpportunityRow()]);
      }
      if (sql.includes('application.idempotency_key = $2')) return result([interestRow(digest)]);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(service.expressInterest(context, input)).resolves.toMatchObject({
      interestId: INTEREST_ID,
      idempotencyReplayed: true,
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);

    await expect(
      service.expressInterest(context, { ...input, expectedOpportunityVersion: 2 })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not mislabel same-opportunity/different-key interest as an idempotent replay', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return result([]);
      if (sql.includes('AS active_provider_identity')) {
        return result([{ active_provider_identity: true }]);
      }
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('current_universal_v1_task_opportunities_v1')) {
        return result([estimateOpportunityRow()]);
      }
      if (sql.includes('application.idempotency_key = $2')) return result([]);
      if (sql.includes('application.opportunity_id = $1::UUID')) {
        return result([interestRow()]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(
      service.expressInterest(context, {
        opportunityId: OPPORTUNITY_ID,
        expectedOpportunityVersion: 1,
        idempotencyKey: 'interest:provider:0002',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reports the exact post-interest gate without minting eligibility or invitation authority', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT application.provider_organization_id')) {
        return result([
          {
            provider_organization_id: null,
            observed_trade_credential_id: null,
          },
        ]);
      }
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('LEFT JOIN LATERAL')) return result([journeyRow()]);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    const response = await service.getMyPreEstimateJourneyState(context, {
      interestId: INTEREST_ID,
    });
    expect(response).toMatchObject({
      interest: { interestId: INTEREST_ID },
      interestStatus: 'pending',
      opportunityCurrent: true,
      providerObservationCurrent: true,
      taskEligibility: {
        state: 'NOT_DECIDED',
        decisionId: null,
        decisionVersion: null,
        taskEligible: null,
        current: false,
      },
      processorEligibility: {
        decisionPresent: false,
        paymentEligibleObservation: false,
        payoutFundingEligibleObservation: false,
        positiveAuthority: 'NONE',
      },
      estimateInvitation: {
        state: 'BLOCKED_BY_TASK_ELIGIBILITY',
        invitationId: null,
        quoteId: null,
      },
      nextStep: 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND',
      blockerCodes: ['ACTOR_ATTESTATION_DECISION_REQUIRED'],
      commandMutationPerformed: false,
      authority: {
        readModelOnly: true,
        databaseCallerIdentityAttested: false,
        initialEligibilityCommand: 'HELD_PENDING_APPROVED_ACTOR_ATTESTATION',
        mutationAuthority: 'NONE',
        financialAuthority: 'NONE',
      },
    });
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toMatch(
      /(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+/u
    );
  });

  it('does not reveal another provider interest through the journey read model', async () => {
    const query = vi.fn().mockResolvedValue(result([]));
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(
      service.getMyPreEstimateJourneyState(context, { interestId: INTEREST_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns an issued quote only from a current exact eligibility and invitation chain', async () => {
    const validUntil = new Date('2030-01-01T00:00:00.000Z');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT application.provider_organization_id')) {
        return result([
          {
            provider_organization_id: null,
            observed_trade_credential_id: null,
          },
        ]);
      }
      if (sql.includes('FROM public.users actor')) return result([generalAuthority()]);
      if (sql.includes('LEFT JOIN LATERAL')) {
        return result([
          journeyRow({
            eligibility_decision_id: ELIGIBILITY_ID,
            eligibility_decision_version: 1,
            eligibility_task_eligible: true,
            processor_payment_eligible: false,
            payout_funding_eligible: false,
            eligibility_valid_until: validUntil,
            eligibility_is_current: true,
            invitation_id: INVITATION_ID,
            invitation_quote_id: QUOTE_ID,
            invitation_valid_until: validUntil,
            invitation_is_current: true,
            expected_quote_version: 0,
          }),
        ]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(
      service.getMyPreEstimateJourneyState(context, { interestId: INTEREST_ID })
    ).resolves.toMatchObject({
      taskEligibility: {
        state: 'CURRENT_ELIGIBLE',
        decisionId: ELIGIBILITY_ID,
        decisionVersion: 1,
        taskEligible: true,
        current: true,
      },
      processorEligibility: {
        paymentEligibleObservation: false,
        payoutFundingEligibleObservation: false,
        positiveAuthority: 'NONE',
      },
      estimateInvitation: {
        state: 'ISSUED',
        invitationId: INVITATION_ID,
        quoteId: QUOTE_ID,
        expectedQuoteVersion: 0,
        validUntil: validUntil.toISOString(),
      },
      nextStep: 'SUBMIT_PROVIDER_ESTIMATE',
      blockerCodes: [],
      commandMutationPerformed: false,
    });
  });

  it('fails closed before returning provider history after actor suspension', async () => {
    const query = vi.fn().mockResolvedValue(result([{ active_provider_identity: false }]));
    const service = new UniversalV1TaskOpportunityService(database(query));

    await expect(service.listMine(context, { limit: 50, offset: 0 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns an Ops model with provider digest only and no participant PII', async () => {
    const query = vi.fn().mockResolvedValue(result([interestRow()]));
    const service = new UniversalV1TaskOpportunityService(database(query));

    const response = await service.listForOps(context, { limit: 50, offset: 0 });
    expect(response).toMatchObject({
      redaction: {
        customerIdentity: 'OMITTED',
        providerIdentity: 'DIGEST_ONLY',
        exactAddress: 'OMITTED',
        contact: 'OMITTED',
        freeFormScope: 'OMITTED',
      },
      interests: [{ providerBindingSha256: 'd'.repeat(64) }],
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(USER_ID);
    expect(serialized).not.toContain(ORGANIZATION_ID);
    expect(serialized).not.toMatch(/email|phone|customerName|street/iu);
  });
});
