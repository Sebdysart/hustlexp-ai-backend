import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn, QueryResult } from '../../src/db.js';
import type {
  AcceptUniversalV1ProviderEstimate,
  IssueUniversalV1ProviderEstimateInvitation,
  SubmitUniversalV1ProviderEstimate,
} from '../../src/services/UniversalV1EstimateContracts.js';
import {
  AcceptUniversalV1ProviderEstimateSchema,
  universalV1EstimateAcceptanceRequestSha256,
} from '../../src/services/UniversalV1EstimateContracts.js';
import { PostgresUniversalV1EstimateRepository } from '../../src/services/UniversalV1EstimatePostgresRepository.js';
import {
  UniversalV1EstimateError,
  UniversalV1EstimateService,
  type UniversalV1EstimateRepository,
} from '../../src/services/UniversalV1EstimateService.js';

const ids = {
  draft: '00000000-0000-4000-8000-000000000101',
  priorRoute: '00000000-0000-4000-8000-000000000102',
  quote: '00000000-0000-4000-8000-000000000103',
  quoteVersion: '00000000-0000-4000-8000-000000000104',
  submission: '00000000-0000-4000-8000-000000000105',
  provider: '00000000-0000-4000-8000-000000000106',
  providerActor: '00000000-0000-4000-8000-000000000107',
  organization: '00000000-0000-4000-8000-000000000108',
  poster: '00000000-0000-4000-8000-000000000109',
  materialization: '00000000-0000-4000-8000-000000000110',
  task: '00000000-0000-4000-8000-000000000111',
  scope: '00000000-0000-4000-8000-000000000112',
  resultingRoute: '00000000-0000-4000-8000-000000000113',
  policy: '00000000-0000-4000-8000-000000000114',
  eligibility: '00000000-0000-4000-8000-000000000115',
  invitation: '00000000-0000-4000-8000-000000000116',
  operator: '00000000-0000-4000-8000-000000000117',
} as const;

const scope = {
  title: 'Seasonal yard cleanup',
  description: 'Remove leaves and weeds from the bounded front-yard area.',
  requirements: 'Customer supplies green-waste bins.',
  checklist: ['Remove leaves', 'Pull visible weeds', 'Photograph completed area'],
  work_category_code: 'yard',
  region_code: 'US-WA',
  rough_location: 'Bellevue, WA 98004',
  risk_level: 'LOW' as const,
  requires_proof: true,
};

const lineItems = [
  {
    description: 'Yard cleanup labor',
    quantity: 2,
    unit_amount_cents: 5_000,
    total_amount_cents: 10_000,
  },
];

function submissionCommand(
  overrides: Partial<SubmitUniversalV1ProviderEstimate> = {}
): SubmitUniversalV1ProviderEstimate {
  return {
    task_draft_id: ids.draft,
    routing_decision_id: ids.priorRoute,
    expected_draft_version: 1,
    quote_id: ids.quote,
    expected_quote_version: 0,
    provider: {
      actor_user_id: ids.provider,
      provider_user_id: ids.provider,
      provider_organization_id: null,
    },
    scope,
    line_items: lineItems,
    customer_total_cents: 10_000,
    provider_payout_cents: 8_000,
    currency: 'USD',
    idempotency_key: 'estimate:submit:0001',
    ...overrides,
  };
}

function acceptanceCommand(
  overrides: Partial<AcceptUniversalV1ProviderEstimate> = {}
): AcceptUniversalV1ProviderEstimate {
  return {
    task_draft_id: ids.draft,
    provider_estimate_submission_id: ids.submission,
    quote_id: ids.quote,
    quote_version_id: ids.quoteVersion,
    poster_user_id: ids.poster,
    actor_user_id: ids.poster,
    expected_draft_version: 1,
    idempotency_key: 'estimate:accept:0001',
    ...overrides,
  };
}

function invitationCommand(
  overrides: Partial<IssueUniversalV1ProviderEstimateInvitation> = {},
): IssueUniversalV1ProviderEstimateInvitation {
  return {
    eligibility_decision_id: ids.eligibility,
    expected_draft_version: 1,
    expected_eligibility_version: 2,
    actor_user_id: ids.operator,
    idempotency_key: 'estimate:invite:0001',
    ...overrides,
  };
}

function rows<T>(values: T[]): QueryResult<T> {
  return { rows: values, rowCount: values.length };
}

function databaseFixture(dispatch: QueryFn) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const transactionQuery: QueryFn = async <T>(sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return dispatch<T>(sql, params);
  };
  const directQuery = vi.fn(async () => {
    throw new Error('query escaped the serializable transaction');
  });
  let serializableTransactions = 0;
  const database = {
    query: directQuery,
    readQuery: directQuery,
    transaction: vi.fn(async () => {
      throw new Error('non-serializable transaction used');
    }),
    serializableTransaction: vi.fn(async <T>(work: (query: QueryFn) => Promise<T>) => {
      serializableTransactions += 1;
      return work(transactionQuery);
    }),
    healthCheck: vi.fn(),
    getPool: vi.fn(),
    getPoolStats: vi.fn(),
    close: vi.fn(),
  } as unknown as Database;
  return { database, calls, serializableTransactions: () => serializableTransactions };
}

function estimateReplayRow() {
  return {
    id: ids.submission,
    quote_id: ids.quote,
    quote_version_id: ids.quoteVersion,
    routing_decision_id: ids.priorRoute,
    provider_user_id: ids.provider,
    provider_organization_id: null,
    submitted_by: ids.provider,
    expected_quote_version: 1,
    scope_snapshot: scope,
    scope_hash: 'a'.repeat(64),
    line_items: lineItems,
    customer_total_cents: 10_000,
    provider_payout_cents: 8_000,
    currency: 'USD',
    idempotency_key: 'estimate:submit:0001',
    task_draft_id: ids.draft,
    decision_version: 1,
  };
}

function invitationReplayRow() {
  return {
    id: ids.invitation,
    quote_id: ids.quote,
    task_draft_id: ids.draft,
    routing_decision_id: ids.priorRoute,
    eligibility_decision_id: ids.eligibility,
    routing_decision_version: 1,
    eligibility_decision_version: 2,
    valid_until: new Date('2026-09-07T13:00:00.000Z'),
    request_sha256: 'd'.repeat(64),
    operator_authorized: true,
  };
}

function regionPolicyRow() {
  return {
    id: ids.policy,
    region_code: 'US-WA',
    version: 'us-wa-test-v1',
    policy_hash: 'b'.repeat(64),
    production_enabled: false,
    effective_from: '2026-08-01T00:00:00.000Z',
    effective_until: null,
    legal_approval_effective_at: null,
    legal_approval_review_at: null,
    policy_document: {
      schemaVersion: 'hxos-region-policy-v1',
      categories: {
        yard: {
          allowedRiskLevels: ['LOW'],
          credentials: {
            licenseRequired: false,
            insuranceRequired: false,
            backgroundCheckRequired: false,
          },
          evidence: {
            proofRequired: true,
            minPhotos: 1,
            maxPhotos: 5,
            gpsRequired: false,
          },
        },
      },
      recording: { allowed: false, standaloneConsentRequired: true },
      workerRights: {
        standaloneScreeningConsentRequired: true,
        reportAccessRequired: true,
        disputeAndAppealRequired: true,
        adverseActionNoticeRequired: true,
      },
      financial: {
        currency: 'usd',
        minimumCustomerCents: 5_000,
        minimumPayoutCents: 4_000,
        minimumMarginCents: 500,
      },
      safety: {
        incidentIntakeRequired: true,
        timedCheckinRiskLevels: ['MEDIUM'],
        checkinIntervalsMinutes: [15, 30, 60],
        locationRetentionDays: 30,
        alternateEmergencyActionRequired: true,
      },
    },
  };
}

function acceptanceContext(overrides: Record<string, unknown> = {}) {
  return {
    task_draft_id: ids.draft,
    poster_user_id: ids.poster,
    task_id: null,
    ingress_origin: 'BACKEND_POSTGRESQL',
    draft_status: 'account_claimed',
    draft_quote_id: null,
    universal_contract_version: 1,
    prior_routing_decision_id: ids.priorRoute,
    decision_version: 1,
    route_outcome: 'ESTIMATE_REQUIRED',
    provider_estimate_submission_id: ids.submission,
    quote_id: ids.quote,
    quote_version_id: ids.quoteVersion,
    quote_kind: 'PROVIDER_ESTIMATE',
    active_version_id: ids.quoteVersion,
    provider_user_id: ids.provider,
    provider_organization_id: null,
    work_category_code: 'yard',
    scope_snapshot: scope,
    scope_hash: 'a'.repeat(64),
    customer_total_cents: 10_000,
    provider_payout_cents: 8_000,
    currency: 'USD',
    ...overrides,
  };
}

describe('UniversalV1EstimateService invitation issuance', () => {
  it('atomically creates one empty quote shell and immutable named-operator invitation', async () => {
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (
        sql.includes('FROM task_provider_estimate_invitations invitation')
        && sql.includes("decision_authority = 'NAMED_OPERATOR'")
      ) {
        return rows([]) as QueryResult<T>;
      }
      if (sql.includes('FROM task_provider_eligibility_decisions eligibility')) {
        return rows([{
          task_draft_id: ids.draft,
          routing_decision_id: ids.priorRoute,
          provider_user_id: ids.provider,
          provider_organization_id: null,
          eligibility_decision_version: 2,
          eligibility_valid_until: new Date('2026-09-07T13:00:00.000Z'),
          routing_decision_version: 1,
          existing_invitation_id: null,
          operator_authorized: true,
          provider_self_selection_clear: true,
          provider_authority_current: true,
          route_context_current: true,
          eligibility_context_current: true,
          eligibility_expired: false,
          eligibility_snapshot_valid: true,
        }]) as QueryResult<T>;
      }
      if (sql.includes('INSERT INTO quotes')) return rows([{ id: ids.quote }]) as QueryResult<T>;
      if (sql.includes('INSERT INTO task_provider_estimate_invitations')) {
        return rows([invitationReplayRow()]) as QueryResult<T>;
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const generated = [ids.quote, ids.invitation];
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(
        fixture.database,
        () => generated.shift()!,
      ),
    );

    await expect(service.issueProviderEstimateInvitation(invitationCommand()))
      .resolves.toEqual({
        invitation_id: ids.invitation,
        quote_id: ids.quote,
        task_draft_id: ids.draft,
        routing_decision_id: ids.priorRoute,
        eligibility_decision_id: ids.eligibility,
        expected_draft_version: 1,
        expected_eligibility_version: 2,
        valid_until: '2026-09-07T13:00:00.000Z',
        request_sha256: 'd'.repeat(64),
        replayed: false,
        payment_creation_performed: false,
        financial_security_event_created: false,
        conditional_hold_created: false,
        hard_assignment_created: false,
        work_order_created: false,
        universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
      });

    expect(fixture.serializableTransactions()).toBe(1);
    const contextSql = fixture.calls.find(({ sql }) =>
      sql.includes('FOR UPDATE OF eligibility, draft, route')
    )!.sql;
    expect(contextSql).toContain('operator_role.can_manage_operations IS TRUE');
    expect(contextSql).toContain('draft.active_routing_decision_id = route.id');
    expect(contextSql).toContain("route.outcome = 'ESTIMATE_REQUIRED'");
    expect(contextSql).toContain('newer.decision_version > eligibility.decision_version');
    expect(contextSql).toContain('universal_v1_invited_provider_authority_is_current');
    expect(contextSql).toContain('provider_self_selection_clear');
    const invitationInsert = fixture.calls.find(({ sql }) =>
      sql.includes('INSERT INTO task_provider_estimate_invitations')
    )!;
    expect(invitationInsert.sql).toContain("'NAMED_OPERATOR'");
    expect(invitationInsert.params).toContain(ids.operator);
    expect(invitationInsert.params).toContain('estimate:invite:0001');
    expect(fixture.calls.some(({ sql }) =>
      /\b(?:escrows|task_financial_security_events|task_reservations|task_work_orders)\b/iu
        .test(sql)
    )).toBe(false);
  });

  it('replays the exact actor/key command and rejects changed expected versions without writes', async () => {
    let operatorAuthorized = true;
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes("decision_authority = 'NAMED_OPERATOR'")) {
        return rows([{
          ...invitationReplayRow(),
          operator_authorized: operatorAuthorized,
        }]) as QueryResult<T>;
      }
      throw new Error(`replay performed an unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database),
    );

    await expect(service.issueProviderEstimateInvitation(invitationCommand()))
      .resolves.toMatchObject({
        invitation_id: ids.invitation,
        quote_id: ids.quote,
        replayed: true,
      });
    await expect(service.issueProviderEstimateInvitation(invitationCommand({
      expected_eligibility_version: 3,
    }))).rejects.toMatchObject({
      code: 'ESTIMATE_INVITATION_IDEMPOTENCY_CONFLICT',
    });
    operatorAuthorized = false;
    await expect(service.issueProviderEstimateInvitation(invitationCommand()))
      .rejects.toMatchObject({
        code: 'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED',
      });
    expect(fixture.calls.some(({ sql }) => /\bINSERT\b/iu.test(sql))).toBe(false);
  });

  it('fails closed before quote creation for an unauthorized or self-selecting operator', async () => {
    for (const override of [
      { operator_authorized: false },
      { provider_self_selection_clear: false },
    ]) {
      const dispatch: QueryFn = async <T>(sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
        if (sql.includes("decision_authority = 'NAMED_OPERATOR'")) {
          return rows([]) as QueryResult<T>;
        }
        if (sql.includes('FROM task_provider_eligibility_decisions eligibility')) {
          return rows([{
            task_draft_id: ids.draft,
            routing_decision_id: ids.priorRoute,
            provider_user_id: ids.provider,
            provider_organization_id: null,
            eligibility_decision_version: 2,
            eligibility_valid_until: new Date('2026-09-07T13:00:00.000Z'),
            routing_decision_version: 1,
            existing_invitation_id: null,
            operator_authorized: true,
            provider_self_selection_clear: true,
            provider_authority_current: true,
            route_context_current: true,
            eligibility_context_current: true,
            eligibility_expired: false,
            eligibility_snapshot_valid: true,
            ...override,
          }]) as QueryResult<T>;
        }
        throw new Error(`unexpected query: ${sql}`);
      };
      const fixture = databaseFixture(dispatch);
      const service = new UniversalV1EstimateService(
        new PostgresUniversalV1EstimateRepository(fixture.database),
      );
      await expect(service.issueProviderEstimateInvitation(invitationCommand()))
        .rejects.toMatchObject({
          code: override.operator_authorized === false
            ? 'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED'
            : 'ESTIMATE_INVITATION_NOT_ALLOWED',
        });
      expect(fixture.calls.some(({ sql }) => /\bINSERT\b/iu.test(sql))).toBe(false);
    }
  });
});

describe('UniversalV1EstimateService provider submission', () => {
  it('submits one payment-free estimate version against a pre-existing exact invitation', async () => {
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM provider_estimate_submissions estimate')) {
        return rows([]) as QueryResult<T>;
      }
      if (sql.includes('FROM task_drafts draft') && sql.includes('route.reason_codes')) {
        return rows([
          {
            task_draft_id: ids.draft,
            decision_version: 1,
            outcome: 'ESTIMATE_REQUIRED',
            reason_codes: ['VARIABLE_SCOPE_REQUIRES_ESTIMATE'],
            category_snapshot: 'yard',
            universal_contract_version: 1,
          },
        ]) as QueryResult<T>;
      }
      if (sql.includes('FROM capability_profiles profile')) {
        return rows([{ authorized: true }]) as QueryResult<T>;
      }
      if (sql.includes('FROM quotes quote')) {
        return rows([
          {
            id: ids.quote,
            task_draft_id: ids.draft,
            task_id: null,
            quote_kind: 'PROVIDER_ESTIMATE',
            provider_user_id: ids.provider,
            provider_organization_id: null,
            routing_decision_id: ids.priorRoute,
            active_version_id: null,
            active_expected_quote_version: null,
            invitation_id: '00000000-0000-4000-8000-000000000091',
            invitation_task_draft_id: ids.draft,
            invitation_routing_decision_id: ids.priorRoute,
            invitation_provider_user_id: ids.provider,
            invitation_provider_organization_id: null,
            invitation_work_category_code: 'yard',
            invitation_valid_until: new Date(Date.now() + 60_000),
          },
        ]) as QueryResult<T>;
      }
      if (sql.includes('INSERT INTO quote_versions')) {
        return rows([{ id: ids.quoteVersion, scope_hash: 'a'.repeat(64) }]) as QueryResult<T>;
      }
      if (sql.includes('UPDATE quotes')) return rows([{ id: ids.quote }]) as QueryResult<T>;
      if (sql.includes('INSERT INTO provider_estimate_submissions')) {
        return rows([estimateReplayRow()]) as QueryResult<T>;
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const repository = new PostgresUniversalV1EstimateRepository(
      fixture.database,
      (() => {
        const generated = [ids.quoteVersion, ids.submission];
        return () => generated.shift()!;
      })()
    );
    const result = await new UniversalV1EstimateService(repository).submitProviderEstimate(
      submissionCommand()
    );

    expect(result).toMatchObject({
      provider_estimate_submission_id: ids.submission,
      quote_version_id: ids.quoteVersion,
      quote_version: 1,
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(fixture.serializableTransactions()).toBe(1);
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO quotes'))).toBe(false);
    const versionSql = fixture.calls.find(({ sql }) =>
      sql.includes('INSERT INTO quote_versions')
    )!.sql;
    expect(versionSql).toContain("1, 'PAYMENT_FREE_ESTIMATE'");
    expect(versionSql).toContain('expires_at');
    expect(versionSql).toContain('NULL, NULL, NULL, NULL, NULL, NULL');
    const submissionCall = fixture.calls.find(({ sql }) =>
      sql.includes('INSERT INTO provider_estimate_submissions')
    )!;
    expect(submissionCall.sql).toContain("'workCategoryCode'");
    expect(submissionCall.params).toContain('yard');
    expect(fixture.calls.some(({ sql }) => /INSERT INTO\s+escrows/iu.test(sql))).toBe(false);
  });

  it('refuses provider self-selection when no exact quote invitation exists', async () => {
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM provider_estimate_submissions estimate'))
        return rows([]) as QueryResult<T>;
      if (sql.includes('FROM task_drafts draft')) {
        return rows([
          {
            task_draft_id: ids.draft,
            decision_version: 1,
            outcome: 'ESTIMATE_REQUIRED',
            reason_codes: ['VARIABLE_SCOPE_REQUIRES_ESTIMATE'],
            category_snapshot: 'yard',
            universal_contract_version: 1,
          },
        ]) as QueryResult<T>;
      }
      if (sql.includes('FROM capability_profiles profile')) {
        return rows([{ authorized: true }]) as QueryResult<T>;
      }
      if (sql.includes('FROM quotes quote')) return rows([]) as QueryResult<T>;
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database)
    );

    await expect(service.submitProviderEstimate(submissionCommand())).rejects.toMatchObject({
      code: 'ESTIMATE_INVITATION_REQUIRED',
    });
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO quote_versions'))).toBe(false);
  });

  it('replays exact normalized input and conflicts when the same key changes', async () => {
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM provider_estimate_submissions estimate')) {
        return rows([estimateReplayRow()]) as QueryResult<T>;
      }
      throw new Error(`replay performed an unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database)
    );

    const replay = await service.submitProviderEstimate(submissionCommand());
    expect(replay.replayed).toBe(true);
    await expect(
      service.submitProviderEstimate(
        submissionCommand({
          scope: { ...scope, title: 'Changed yard cleanup scope' },
        })
      )
    ).rejects.toMatchObject({ code: 'ESTIMATE_IDEMPOTENCY_CONFLICT' });
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('requires the exact current government-backed trade qualification', async () => {
    const tradeCommand = submissionCommand({
      provider: {
        actor_user_id: ids.providerActor,
        provider_user_id: ids.provider,
        provider_organization_id: ids.organization,
      },
      scope: { ...scope, work_category_code: 'plumbing' },
    });
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM provider_estimate_submissions estimate'))
        return rows([]) as QueryResult<T>;
      if (sql.includes('FROM task_drafts draft')) {
        return rows([
          {
            task_draft_id: ids.draft,
            decision_version: 1,
            outcome: 'ESTIMATE_REQUIRED',
            reason_codes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
            category_snapshot: 'plumbing',
            universal_contract_version: 1,
          },
        ]) as QueryResult<T>;
      }
      if (sql.includes('FROM business_organizations organization')) {
        expect(sql).toContain('qualification.jurisdiction_code = $4');
        expect(sql).toContain('lower(permitted.category) = lower($5)');
        return rows([
          {
            provider_class: 'VERIFIED_TRADE_BUSINESS',
            organization_authorized: true,
            actor_membership_authorized: true,
            provider_membership_authorized: true,
            trade_qualification_authorized: false,
          },
        ]) as QueryResult<T>;
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database)
    );

    await expect(service.submitProviderEstimate(tradeCommand)).rejects.toMatchObject({
      code: 'ESTIMATE_TRADE_QUALIFICATION_REQUIRED',
    });
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(false);
  });
});

describe('UniversalV1EstimateService customer acceptance', () => {
  it('atomically creates one unassigned payment-frozen Task, scope v1, route, and acceptance fact', async () => {
    const command = acceptanceCommand();
    const generated = [ids.materialization, ids.task, ids.scope, ids.resultingRoute];
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM task_estimate_acceptance_materializations materialization')) {
        return rows([]) as QueryResult<T>;
      }
      if (sql.includes('FROM task_drafts draft') && sql.includes('provider_estimate_submissions')) {
        return rows([acceptanceContext()]) as QueryResult<T>;
      }
      if (sql.includes('FROM region_policies policy')) {
        return rows([regionPolicyRow()]) as QueryResult<T>;
      }
      if (sql.includes('INSERT INTO tasks')) return rows([{ id: ids.task }]) as QueryResult<T>;
      if (sql.includes('INSERT INTO task_scope_versions')) {
        return rows([{ id: ids.scope }]) as QueryResult<T>;
      }
      if (sql.includes('UPDATE tasks')) return rows([{ id: ids.task }]) as QueryResult<T>;
      if (sql.includes('INSERT INTO task_routing_decisions')) {
        return rows([{ id: ids.resultingRoute }]) as QueryResult<T>;
      }
      if (sql.includes('UPDATE task_drafts')) return rows([{ id: ids.draft }]) as QueryResult<T>;
      if (sql.includes('UPDATE quotes')) return rows([{ id: ids.quote }]) as QueryResult<T>;
      if (sql.includes('INSERT INTO task_estimate_acceptance_materializations')) {
        return rows([
          {
            id: ids.materialization,
            task_draft_id: ids.draft,
            provider_estimate_submission_id: ids.submission,
            quote_id: ids.quote,
            quote_version_id: ids.quoteVersion,
            poster_user_id: ids.poster,
            prior_routing_decision_id: ids.priorRoute,
            resulting_routing_decision_id: ids.resultingRoute,
            task_id: ids.task,
            scope_version_id: ids.scope,
            expected_draft_version: 1,
            idempotency_key: command.idempotency_key,
            request_sha256: universalV1EstimateAcceptanceRequestSha256(
              AcceptUniversalV1ProviderEstimateSchema.parse(command)
            ),
            materialization_version: 1,
          },
        ]) as QueryResult<T>;
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const repository = new PostgresUniversalV1EstimateRepository(
      fixture.database,
      () => generated.shift()!
    );
    const result = await new UniversalV1EstimateService(repository).acceptProviderEstimate(command);

    expect(result).toMatchObject({
      task_id: ids.task,
      scope_version_id: ids.scope,
      prior_routing_decision_id: ids.priorRoute,
      resulting_routing_decision_id: ids.resultingRoute,
      resulting_draft_version: 2,
      replayed: false,
      payment_creation_performed: false,
      escrow_created: false,
      hard_assignment_created: false,
      universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
    });
    expect(fixture.serializableTransactions()).toBe(1);
    const taskInsert = fixture.calls.find(({ sql }) => sql.includes('INSERT INTO tasks'))!.sql;
    expect(taskInsert).toContain('worker_id');
    expect(taskInsert).toContain("'universal_financial_security', NULL");
    const promotion = fixture.calls.find(({ sql }) => sql.includes('UPDATE tasks'))!.sql;
    expect(promotion).toContain("universal_payment_posture = 'PAYMENT_CREATION_FROZEN'");
    const draftBind = fixture.calls.find(({ sql }) => sql.includes('UPDATE task_drafts'))!.sql;
    expect(draftBind).toContain('active_routing_decision_id = $4');
    expect(draftBind).toContain('quote_id = $5');
    expect(draftBind).not.toContain("status = 'quote_approved'");
    expect(fixture.calls.some(({ sql }) => /INSERT INTO\s+escrows/iu.test(sql))).toBe(false);
    expect(
      fixture.calls.some(({ sql }) => /task_financial_security_events|task_work_orders/iu.test(sql))
    ).toBe(false);
    expect(fixture.calls.some(({ sql }) => /UPDATE\s+quote_versions/iu.test(sql))).toBe(false);
  });

  it('replays the exact acceptance fact and rejects changed input without writes', async () => {
    const command = acceptanceCommand();
    const requestSha256 = universalV1EstimateAcceptanceRequestSha256(
      AcceptUniversalV1ProviderEstimateSchema.parse(command)
    );
    const replayRow = {
      id: ids.materialization,
      task_draft_id: ids.draft,
      provider_estimate_submission_id: ids.submission,
      quote_id: ids.quote,
      quote_version_id: ids.quoteVersion,
      poster_user_id: ids.poster,
      prior_routing_decision_id: ids.priorRoute,
      resulting_routing_decision_id: ids.resultingRoute,
      task_id: ids.task,
      scope_version_id: ids.scope,
      expected_draft_version: 1,
      idempotency_key: command.idempotency_key,
      request_sha256: requestSha256,
      materialization_version: 1,
      resulting_draft_version: 2,
    };
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM task_estimate_acceptance_materializations materialization')) {
        return rows([replayRow]) as QueryResult<T>;
      }
      throw new Error(`replay performed an unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database)
    );

    const replay = await service.acceptProviderEstimate(command);
    expect(replay.replayed).toBe(true);
    await expect(
      service.acceptProviderEstimate(
        acceptanceCommand({
          quote_version_id: '00000000-0000-4000-8000-000000000199',
        })
      )
    ).rejects.toMatchObject({ code: 'ESTIMATE_ACCEPTANCE_IDEMPOTENCY_CONFLICT' });
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('rejects a customer identity substitution before opening a transaction', async () => {
    const repository = {
      issueProviderEstimateInvitation: vi.fn(),
      submitProviderEstimate: vi.fn(),
      acceptProviderEstimate: vi.fn(),
    } satisfies UniversalV1EstimateRepository;
    const service = new UniversalV1EstimateService(repository);

    await expect(
      service.acceptProviderEstimate(
        acceptanceCommand({
          actor_user_id: ids.provider,
        })
      )
    ).rejects.toThrow();
    expect(repository.acceptProviderEstimate).not.toHaveBeenCalled();
  });

  it('fails closed on an expected-version mismatch before creating a Task', async () => {
    const dispatch: QueryFn = async <T>(sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return rows([]) as QueryResult<T>;
      if (sql.includes('FROM task_estimate_acceptance_materializations materialization')) {
        return rows([]) as QueryResult<T>;
      }
      if (sql.includes('FROM task_drafts draft')) {
        return rows([acceptanceContext({ decision_version: 2 })]) as QueryResult<T>;
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const fixture = databaseFixture(dispatch);
    const service = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(fixture.database)
    );

    await expect(service.acceptProviderEstimate(acceptanceCommand())).rejects.toMatchObject({
      code: 'ESTIMATE_ACCEPTANCE_VERSION_CONFLICT',
    });
    expect(fixture.calls.some(({ sql }) => sql.includes('INSERT INTO tasks'))).toBe(false);
  });
});

describe('UniversalV1EstimateError', () => {
  it('retains a stable machine-readable domain code', () => {
    const error = new UniversalV1EstimateError('ESTIMATE_ROUTE_NOT_ACTIVE', 'route changed');
    expect(error).toMatchObject({
      name: 'UniversalV1EstimateError',
      code: 'ESTIMATE_ROUTE_NOT_ACTIVE',
      message: 'route changed',
    });
  });
});
