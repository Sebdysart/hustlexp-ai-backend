import { describe, expect, it, vi } from 'vitest';

import {
  AcceptUniversalV1ProviderEstimatePublicSchema,
  IssueUniversalV1ProviderEstimateInvitationPublicSchema,
  SubmitUniversalV1ProviderEstimatePublicSchema,
  UniversalV1EstimateApplication,
  UniversalV1EstimatePublicError,
  type TrustedUniversalV1EstimateAcceptance,
  type TrustedUniversalV1EstimateInvitation,
  type UniversalV1EstimateCommandService,
  type UniversalV1EstimatePublicFactReader,
} from '../../src/services/UniversalV1EstimateApplication.js';
import {
  UniversalV1EstimateError,
} from '../../src/services/UniversalV1EstimateService.js';
import {
  PostgresUniversalV1EstimatePublicFactReader,
} from '../../src/services/UniversalV1EstimatePublicFacts.js';
import {
  createUniversalContractRouter,
  universalV1EstimateRouteError,
} from '../../src/routers/universalContract.js';
import type { QueryFn } from '../../src/db.js';
import { db } from '../../src/db.js';
import type { User } from '../../src/types.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const ids = {
  actor: '00000000-0000-4000-8000-000000000101',
  otherActor: '00000000-0000-4000-8000-000000000102',
  invitation: '00000000-0000-4000-8000-000000000103',
  eligibility: '00000000-0000-4000-8000-000000000115',
  quote: '00000000-0000-4000-8000-000000000104',
  quoteVersion: '00000000-0000-4000-8000-000000000105',
  draft: '00000000-0000-4000-8000-000000000106',
  route: '00000000-0000-4000-8000-000000000107',
  provider: '00000000-0000-4000-8000-000000000108',
  organization: '00000000-0000-4000-8000-000000000109',
  submission: '00000000-0000-4000-8000-000000000110',
  materialization: '00000000-0000-4000-8000-000000000111',
  task: '00000000-0000-4000-8000-000000000112',
  scope: '00000000-0000-4000-8000-000000000113',
  resultingRoute: '00000000-0000-4000-8000-000000000114',
} as const;

const scope = {
  title: 'Licensed sink repair estimate',
  description: 'Replace the failed sink valve and verify that the connection is watertight.',
  requirements: 'Customer will provide access to the shutoff valve.',
  checklist: ['Confirm shutoff', 'Replace valve', 'Leak test'],
};

const lineItems = [{
  description: 'Labor and replacement valve',
  quantity: 1,
  unit_amount_cents: 15_000,
  total_amount_cents: 15_000,
}];

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    quote_id: ids.quote,
    expected_draft_version: 3,
    expected_quote_version: 0,
    scope,
    line_items: lineItems,
    customer_total_cents: 15_000,
    provider_payout_cents: 12_000,
    idempotency_key: 'estimate:submit:0001',
    client_ts: NOW,
    ...overrides,
  };
}

function acceptInput(overrides: Record<string, unknown> = {}) {
  return {
    provider_estimate_submission_id: ids.submission,
    expected_draft_version: 3,
    expected_quote_version: 1,
    idempotency_key: 'estimate:accept:0001',
    client_ts: NOW,
    ...overrides,
  };
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    eligibility_decision_id: ids.eligibility,
    expected_draft_version: 3,
    expected_eligibility_version: 2,
    idempotency_key: 'estimate:invite:0001',
    client_ts: NOW,
    ...overrides,
  };
}

function invitation(
  overrides: Partial<TrustedUniversalV1EstimateInvitation> = {},
): TrustedUniversalV1EstimateInvitation {
  return {
    invitation_id: ids.invitation,
    quote_id: ids.quote,
    task_draft_id: ids.draft,
    routing_decision_id: ids.route,
    expected_draft_version: 3,
    expected_quote_version: 0,
    provider_user_id: ids.provider,
    provider_organization_id: ids.organization,
    work_category_code: 'plumbing',
    region_code: 'US-CA',
    rough_location: 'Oakland, CA',
    risk_level: 'IN_HOME',
    requires_proof: true,
    currency: 'USD',
    ...overrides,
  };
}

function acceptance(
  overrides: Partial<TrustedUniversalV1EstimateAcceptance> = {},
): TrustedUniversalV1EstimateAcceptance {
  return {
    provider_estimate_submission_id: ids.submission,
    task_draft_id: ids.draft,
    quote_id: ids.quote,
    quote_version_id: ids.quoteVersion,
    poster_user_id: ids.actor,
    expected_draft_version: 3,
    expected_quote_version: 1,
    ...overrides,
  };
}

function submittedResult() {
  return {
    provider_estimate_submission_id: ids.submission,
    quote_id: ids.quote,
    quote_version_id: ids.quoteVersion,
    quote_version: 1,
    routing_decision_id: ids.route,
    scope_sha256: 'a'.repeat(64),
    request_sha256: 'b'.repeat(64),
    replayed: false,
    payment_creation_performed: false as const,
    hard_assignment_created: false as const,
  };
}

function issuedResult() {
  return {
    invitation_id: ids.invitation,
    quote_id: ids.quote,
    task_draft_id: ids.draft,
    routing_decision_id: ids.route,
    eligibility_decision_id: ids.eligibility,
    expected_draft_version: 3,
    expected_eligibility_version: 2,
    valid_until: '2026-09-07T13:00:00.000Z',
    request_sha256: 'd'.repeat(64),
    replayed: false,
    payment_creation_performed: false as const,
    financial_security_event_created: false as const,
    conditional_hold_created: false as const,
    hard_assignment_created: false as const,
    work_order_created: false as const,
    universal_payment_posture: 'PAYMENT_CREATION_FROZEN' as const,
  };
}

function acceptedResult() {
  return {
    materialization_id: ids.materialization,
    task_draft_id: ids.draft,
    task_id: ids.task,
    scope_version_id: ids.scope,
    provider_estimate_submission_id: ids.submission,
    prior_routing_decision_id: ids.route,
    resulting_routing_decision_id: ids.resultingRoute,
    resulting_draft_version: 4,
    request_sha256: 'c'.repeat(64),
    replayed: false,
    payment_creation_performed: false as const,
    escrow_created: false as const,
    hard_assignment_created: false as const,
    universal_payment_posture: 'PAYMENT_CREATION_FROZEN' as const,
  };
}

function fixture(options: {
  invitation?: TrustedUniversalV1EstimateInvitation | null;
  acceptance?: TrustedUniversalV1EstimateAcceptance | null;
} = {}) {
  const loadSubmissionInvitation = vi.fn().mockResolvedValue(
    options.invitation === undefined ? invitation() : options.invitation,
  );
  const loadAcceptance = vi.fn().mockResolvedValue(
    options.acceptance === undefined ? acceptance() : options.acceptance,
  );
  const submitProviderEstimate = vi.fn().mockResolvedValue(submittedResult());
  const acceptProviderEstimate = vi.fn().mockResolvedValue(acceptedResult());
  const issueProviderEstimateInvitation = vi.fn().mockResolvedValue(issuedResult());
  const facts: UniversalV1EstimatePublicFactReader = {
    loadSubmissionInvitation,
    loadAcceptance,
  };
  const estimates: UniversalV1EstimateCommandService = {
    issueProviderEstimateInvitation,
    submitProviderEstimate,
    acceptProviderEstimate,
  };
  return {
    application: new UniversalV1EstimateApplication(facts, estimates, () => NOW),
    loadSubmissionInvitation,
    loadAcceptance,
    submitProviderEstimate,
    acceptProviderEstimate,
    issueProviderEstimateInvitation,
  };
}

function activeAdult(defaultMode: 'worker' | 'poster' = 'worker'): User {
  return {
    id: ids.actor,
    email: 'estimate@example.invalid',
    full_name: 'Estimate Actor',
    default_mode: defaultMode,
    is_minor: false,
    role_was_overridden: false,
    trust_tier: 0,
    trust_hold: false,
    xp_total: 0,
    current_level: 1,
    current_streak: 0,
    is_verified: false,
    student_id_verified: false,
    plan: 'free',
    live_mode_state: 'OFF',
    live_mode_total_tasks: 0,
    daily_active_minutes: 0,
    consecutive_active_days: 0,
    account_status: 'ACTIVE',
  };
}

function caller(
  application: UniversalV1EstimateApplication,
  user: User | null = activeAdult(),
) {
  return createUniversalContractRouter(application).createCaller({
    user,
    firebaseUid: user ? 'firebase-estimate-actor' : null,
    ip: '203.0.113.42',
  });
}

describe('Universal V1 public estimate schemas', () => {
  it('rejects every client attempt to select identity or authoritative scope facts', () => {
    for (const spoof of [
      { actor_user_id: ids.otherActor },
      { poster_user_id: ids.otherActor },
      { provider_user_id: ids.otherActor },
      { provider_organization_id: ids.organization },
      { task_draft_id: ids.draft },
      { routing_decision_id: ids.route },
      { currency: 'EUR' },
    ]) {
      expect(SubmitUniversalV1ProviderEstimatePublicSchema.safeParse({
        ...submitInput(),
        ...spoof,
      }).success).toBe(false);
    }
    for (const spoof of [
      { work_category_code: 'electrical' },
      { region_code: 'US-NY' },
      { rough_location: 'New York, NY' },
      { risk_level: 'LOW' },
      { requires_proof: false },
    ]) {
      expect(SubmitUniversalV1ProviderEstimatePublicSchema.safeParse({
        ...submitInput(),
        scope: { ...scope, ...spoof },
      }).success).toBe(false);
    }
    for (const spoof of [
      { actor_user_id: ids.otherActor },
      { poster_user_id: ids.otherActor },
      { task_draft_id: ids.draft },
      { quote_id: ids.quote },
      { quote_version_id: ids.quoteVersion },
    ]) {
      expect(AcceptUniversalV1ProviderEstimatePublicSchema.safeParse({
        ...acceptInput(),
        ...spoof,
      }).success).toBe(false);
    }
    for (const spoof of [
      { actor_user_id: ids.otherActor },
      { provider_user_id: ids.provider },
      { provider_organization_id: ids.organization },
      { task_draft_id: ids.draft },
      { routing_decision_id: ids.route },
      { quote_id: ids.quote },
      { valid_until: '2026-09-07T13:00:00.000Z' },
      { decision_authority: 'DETERMINISTIC_POLICY' },
      { authority_policy_version: 'attacker-policy' },
    ]) {
      expect(IssueUniversalV1ProviderEstimateInvitationPublicSchema.safeParse({
        ...issueInput(),
        ...spoof,
      }).success).toBe(false);
    }
  });
});

describe('UniversalV1EstimateApplication', () => {
  it('injects the named actor while leaving provider, route, credential, validity, and quote selection to PostgreSQL', async () => {
    const test = fixture();
    await expect(test.application.issueProviderEstimateInvitation(
      ids.actor,
      issueInput(),
    )).resolves.toEqual(issuedResult());

    expect(test.issueProviderEstimateInvitation).toHaveBeenCalledWith({
      eligibility_decision_id: ids.eligibility,
      expected_draft_version: 3,
      expected_eligibility_version: 2,
      actor_user_id: ids.actor,
      idempotency_key: 'estimate:invite:0001',
    });
    expect(JSON.stringify(test.issueProviderEstimateInvitation.mock.calls[0]?.[0]))
      .not.toMatch(/client_ts|provider_user|organization|credential|valid_until|quote_id/iu);
  });

  it('derives every provider, route, policy, and currency field from the invitation', async () => {
    const test = fixture();
    await expect(test.application.submitProviderEstimate(
      ids.actor,
      submitInput(),
    )).resolves.toEqual(submittedResult());

    expect(test.loadSubmissionInvitation).toHaveBeenCalledWith({
      actorUserId: ids.actor,
      quoteId: ids.quote,
      expectedDraftVersion: 3,
      expectedQuoteVersion: 0,
    });
    expect(test.submitProviderEstimate).toHaveBeenCalledWith({
      task_draft_id: ids.draft,
      routing_decision_id: ids.route,
      expected_draft_version: 3,
      quote_id: ids.quote,
      expected_quote_version: 0,
      provider: {
        actor_user_id: ids.actor,
        provider_user_id: ids.provider,
        provider_organization_id: ids.organization,
      },
      scope: {
        ...scope,
        work_category_code: 'plumbing',
        region_code: 'US-CA',
        rough_location: 'Oakland, CA',
        risk_level: 'IN_HOME',
        requires_proof: true,
      },
      line_items: lineItems,
      customer_total_cents: 15_000,
      provider_payout_cents: 12_000,
      currency: 'USD',
      idempotency_key: 'estimate:submit:0001',
    });
    expect(JSON.stringify(test.submitProviderEstimate.mock.calls[0]?.[0]))
      .not.toMatch(/client_ts|invitation_id|payment|assignment/iu);
  });

  it('derives Poster ownership and every aggregate ID from immutable acceptance facts', async () => {
    const test = fixture();
    await expect(test.application.acceptProviderEstimate(
      ids.actor,
      acceptInput(),
    )).resolves.toEqual(acceptedResult());

    expect(test.loadAcceptance).toHaveBeenCalledWith({
      actorUserId: ids.actor,
      providerEstimateSubmissionId: ids.submission,
      expectedDraftVersion: 3,
      expectedQuoteVersion: 1,
    });
    expect(test.acceptProviderEstimate).toHaveBeenCalledWith({
      task_draft_id: ids.draft,
      provider_estimate_submission_id: ids.submission,
      quote_id: ids.quote,
      quote_version_id: ids.quoteVersion,
      poster_user_id: ids.actor,
      actor_user_id: ids.actor,
      expected_draft_version: 3,
      idempotency_key: 'estimate:accept:0001',
    });
  });

  it('collapses absent or wrong-owner acceptance facts to one opaque not-found error', async () => {
    for (const fact of [null, acceptance({ poster_user_id: ids.otherActor })]) {
      const test = fixture({ acceptance: fact });
      await expect(test.application.acceptProviderEstimate(
        ids.actor,
        acceptInput(),
      )).rejects.toMatchObject({ code: 'ESTIMATE_PUBLIC_NOT_FOUND' });
      expect(test.acceptProviderEstimate).not.toHaveBeenCalled();
    }
  });

  it('returns a conflict when trusted current versions differ from the wire expectation', async () => {
    const submission = fixture({
      invitation: invitation({ expected_draft_version: 4, expected_quote_version: 1 }),
    });
    await expect(submission.application.submitProviderEstimate(
      ids.actor,
      submitInput(),
    )).rejects.toMatchObject({ code: 'ESTIMATE_PUBLIC_VERSION_CONFLICT' });
    expect(submission.submitProviderEstimate).not.toHaveBeenCalled();

    const customer = fixture({
      acceptance: acceptance({ expected_draft_version: 4, expected_quote_version: 2 }),
    });
    await expect(customer.application.acceptProviderEstimate(
      ids.actor,
      acceptInput(),
    )).rejects.toMatchObject({ code: 'ESTIMATE_PUBLIC_VERSION_CONFLICT' });
    expect(customer.acceptProviderEstimate).not.toHaveBeenCalled();
  });

  it('rejects stale and future-dated commands before loading facts or writing', async () => {
    for (const clientTs of [NOW - 10 * 60 * 1_000 - 1, NOW + 10 * 60 * 1_000 + 1]) {
      const test = fixture();
      await expect(test.application.submitProviderEstimate(
        ids.actor,
        submitInput({ client_ts: clientTs }),
      )).rejects.toMatchObject({ code: 'ESTIMATE_PUBLIC_REQUEST_STALE' });
      expect(test.loadSubmissionInvitation).not.toHaveBeenCalled();
      expect(test.submitProviderEstimate).not.toHaveBeenCalled();
    }
    const invitationTest = fixture();
    await expect(invitationTest.application.issueProviderEstimateInvitation(
      ids.actor,
      issueInput({ client_ts: NOW - 10 * 60 * 1_000 - 1 }),
    )).rejects.toMatchObject({ code: 'ESTIMATE_PUBLIC_REQUEST_STALE' });
    expect(invitationTest.issueProviderEstimateInvitation).not.toHaveBeenCalled();
  });

  it('hides raw fact-reader and write-path failures', async () => {
    const test = fixture();
    test.loadSubmissionInvitation.mockRejectedValueOnce(
      new Error('column private_secret does not exist'),
    );
    await expect(test.application.submitProviderEstimate(
      ids.actor,
      submitInput(),
    )).rejects.toMatchObject({
      code: 'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
      message: expect.not.stringContaining('private_secret'),
    });

    test.acceptProviderEstimate.mockRejectedValueOnce(
      new Error('PGPASSWORD leaked in a driver error'),
    );
    await expect(test.application.acceptProviderEstimate(
      ids.actor,
      acceptInput(),
    )).rejects.toMatchObject({
      code: 'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
      message: expect.not.stringContaining('PGPASSWORD'),
    });
  });
});

describe('PostgresUniversalV1EstimatePublicFactReader', () => {
  it('loads only a current exact invitation with actor, eligibility, and provider authority', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [invitation()], rowCount: 1 });
    const reader = new PostgresUniversalV1EstimatePublicFactReader(query as QueryFn);

    await expect(reader.loadSubmissionInvitation({
      actorUserId: ids.actor,
      quoteId: ids.quote,
      expectedDraftVersion: 3,
      expectedQuoteVersion: 0,
    })).resolves.toEqual(invitation());

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ids.quote, ids.actor]);
    expect(sql).toContain('FROM task_provider_estimate_invitations invitation');
    expect(sql).toContain("route.outcome = 'ESTIMATE_REQUIRED'");
    expect(sql).toContain('route.category_snapshot = invitation.work_category_code');
    expect(sql).toContain('invitation.valid_until > clock_timestamp()');
    expect(sql).toContain('newer.decision_version > eligibility.decision_version');
    expect(sql).toContain('public.business_membership_has_action(');
    expect(sql).toContain("'SUBMIT_ESTIMATE'");
    expect(sql).toContain('universal_v1_invited_provider_authority_is_current');
    expect(sql).toContain('invitation.eligibility_evidence_sha256');
    expect(sql).toContain('active_version.expires_at = invitation.valid_until');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('filters acceptance by the authenticated Poster while preserving exact replay evidence', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [acceptance()], rowCount: 1 });
    const reader = new PostgresUniversalV1EstimatePublicFactReader(query as QueryFn);

    await expect(reader.loadAcceptance({
      actorUserId: ids.actor,
      providerEstimateSubmissionId: ids.submission,
      expectedDraftVersion: 3,
      expectedQuoteVersion: 1,
    })).resolves.toEqual(acceptance());

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ids.submission, ids.actor]);
    expect(sql).toContain('materialization.poster_user_id = $2');
    expect(sql).toContain('draft.poster_user_id = $2');
    expect(sql).toContain('estimate.id = $1');
    expect(sql).toContain('WITH completed AS');
    expect(sql).toContain('task_estimate_acceptance_materializations materialization');
    expect(sql).toContain('quote.active_version_id = materialization.quote_version_id');
    expect(sql).toContain('quote.provider_user_id = estimate.provider_user_id');
    expect(sql).toContain(
      'quote.provider_organization_id IS NOT DISTINCT FROM',
    );
    expect(sql).toContain('draft.active_routing_decision_id = route.id');
    expect(sql).toContain('estimate.work_category_code = invitation.work_category_code');
    expect(sql).toContain("estimate.scope_snapshot->>'region_code' = invitation.region_code");
    expect(sql).toContain('quote.created_by IS NOT DISTINCT FROM invitation.quote_created_by');
    expect(sql).toContain('invitation.eligibility_evidence_sha256');
    expect(sql).toContain('universal_v1_invited_provider_authority_is_current');
    expect(sql).toContain('SELECT * FROM completed');
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM completed)');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  });
});

describe('Universal V1 public estimate router', () => {
  it('requires scoped Operations authority and fresh MFA step-up for invitation issuance', async () => {
    const test = fixture();
    const ordinary = { ...activeAdult(), is_admin: false };
    await expect(caller(test.application, ordinary).issueProviderEstimateInvitation(
      issueInput(),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const roleLookup = vi.spyOn(db, 'query');
    roleLookup.mockResolvedValue({
      rows: [{ role: 'support', capability_granted: true }],
      rowCount: 1,
    });
    const operator = { ...activeAdult(), is_admin: true };
    await expect(caller(test.application, operator).issueProviderEstimateInvitation(
      issueInput(),
    )).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const operatorCaller = createUniversalContractRouter(test.application).createCaller({
      user: operator,
      firebaseUid: 'firebase-named-operator',
      identityAssurance: {
        authenticatedAtSeconds: nowSeconds,
        tokenExpiresAtSeconds: nowSeconds + 3_600,
        signInProvider: 'password',
        secondFactor: 'totp',
        mfaVerified: true,
      },
      ip: '203.0.113.42',
    });
    await expect(operatorCaller.issueProviderEstimateInvitation(issueInput()))
      .resolves.toEqual(issuedResult());
    expect(test.issueProviderEstimateInvitation).toHaveBeenCalledWith({
      eligibility_decision_id: ids.eligibility,
      expected_draft_version: 3,
      expected_eligibility_version: 2,
      actor_user_id: ids.actor,
      idempotency_key: 'estimate:invite:0001',
    });
    roleLookup.mockRestore();
  });

  it('requires authentication plus an active adult account without gating default_mode', async () => {
    const test = fixture();
    await expect(caller(test.application, null).submitProviderEstimate(
      submitInput(),
    )).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    for (const user of [
      { ...activeAdult(), is_minor: true },
      { ...activeAdult(), is_minor: undefined },
      { ...activeAdult(), account_status: 'PAUSED' as const },
    ]) {
      await expect(caller(test.application, user).submitProviderEstimate(
        submitInput(),
      )).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }

    await expect(caller(test.application, activeAdult('poster')).submitProviderEstimate(
      submitInput(),
    )).resolves.toEqual(submittedResult());
    await expect(caller(test.application, activeAdult('worker')).acceptProviderEstimate(
      acceptInput(),
    )).resolves.toEqual(acceptedResult());
    expect(test.submitProviderEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: expect.objectContaining({ actor_user_id: ids.actor }) }),
    );
    expect(test.acceptProviderEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: ids.actor, poster_user_id: ids.actor }),
    );
  });

  it('maps public/domain failures stably and never returns a raw database message', () => {
    expect(universalV1EstimateRouteError(new UniversalV1EstimatePublicError(
      'ESTIMATE_PUBLIC_REQUEST_STALE',
      'raw detail',
    ))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(universalV1EstimateRouteError(new UniversalV1EstimateError(
      'ESTIMATE_QUOTE_VERSION_CONFLICT',
      'raw detail',
    ))).toMatchObject({ code: 'CONFLICT' });
    expect(universalV1EstimateRouteError(new UniversalV1EstimateError(
      'ESTIMATE_PROVIDER_NOT_AUTHORIZED',
      'raw detail',
    ))).toMatchObject({ code: 'FORBIDDEN' });
    const raw = universalV1EstimateRouteError(
      new Error('duplicate key on private_estimate_table'),
    );
    expect(raw).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unable to process the Universal V1 command.',
    });
    expect(raw.message).not.toContain('private_estimate_table');
  });
});
