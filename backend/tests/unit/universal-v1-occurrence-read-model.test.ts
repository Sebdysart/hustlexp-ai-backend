import { afterEach, describe, expect, it, vi } from 'vitest';

import { db, type Database, type QueryFn } from '../../src/db.js';
import { createUniversalOccurrenceRouter } from '../../src/routers/universalOccurrence.js';
import {
  PostgresUniversalV1OccurrenceFactReader,
  PostgresUniversalV1OperationsOccurrenceReader,
  UniversalV1OccurrenceReadApplication,
  universalV1OccurrenceProjectionSha256,
  type RawUniversalV1OccurrenceRow,
  type UniversalV1OccurrenceFactReader,
} from '../../src/services/UniversalV1OccurrenceReadModel.js';

const ids = {
  draft: '00000000-0000-4000-8000-000000000101',
  customer: '00000000-0000-4000-8000-000000000102',
  provider: '00000000-0000-4000-8000-000000000103',
  organization: '00000000-0000-4000-8000-000000000104',
  route: '00000000-0000-4000-8000-000000000105',
  eligibility: '00000000-0000-4000-8000-000000000106',
  invitation: '00000000-0000-4000-8000-000000000107',
  estimate: '00000000-0000-4000-8000-000000000108',
  quote: '00000000-0000-4000-8000-000000000109',
  quoteVersion: '00000000-0000-4000-8000-000000000110',
  acceptance: '00000000-0000-4000-8000-000000000111',
  task: '00000000-0000-4000-8000-000000000112',
  scope: '00000000-0000-4000-8000-000000000113',
  interest: '00000000-0000-4000-8000-000000000114',
  hold: '00000000-0000-4000-8000-000000000115',
  workOrder: '00000000-0000-4000-8000-000000000116',
  execution: '00000000-0000-4000-8000-000000000117',
  completion: '00000000-0000-4000-8000-000000000118',
  completionDelivery: '00000000-0000-4000-8000-000000000121',
  terminalIntent: '00000000-0000-4000-8000-000000000119',
  reconciliation: '00000000-0000-4000-8000-000000000120',
  proposal: '00000000-0000-4000-8000-000000000122',
  amendment: '00000000-0000-4000-8000-000000000123',
} as const;

const at = '2026-09-24T12:00:00.000Z';
const operationsPurpose = 'Investigate the exact occurrence state for a named support case.';

function row(
  overrides: Partial<RawUniversalV1OccurrenceRow> = {},
): RawUniversalV1OccurrenceRow {
  return {
    task_draft_id: ids.draft,
    draft_status: 'converted',
    draft_updated_at: at,
    route_id: ids.route,
    route_version: 4,
    route_outcome: 'FULFILLMENT_CANDIDATE',
    route_reason_codes: ['ESTIMATE_ACCEPTED'],
    route_policy_version: 'universal-v1-intake-1.2.0',
    route_category: 'plumbing',
    route_service_cell: 'Oakland, CA',
    route_created_at: at,
    provider_user_id: ids.provider,
    provider_organization_id: ids.organization,
    provider_class: 'VERIFIED_TRADE_BUSINESS',
    qualification_provider_class: 'VERIFIED_TRADE_BUSINESS',
    qualification_credential_type: 'PLUMBING_LICENSE',
    qualification_issuing_authority: 'California Contractors State License Board',
    qualification_jurisdiction_code: 'US-CA',
    qualification_license_scope: 'Residential plumbing repair and installation',
    qualification_license_status: 'ACTIVE',
    qualification_expires_at: '2027-09-24T12:00:00.000Z',
    qualification_verified_at: at,
    qualification_official_source_checked_at: at,
    qualification_permitted_work_categories: ['plumbing'],
    eligibility_id: ids.eligibility,
    eligibility_version: 2,
    eligibility_task_eligible: true,
    eligibility_is_current: true,
    eligibility_blocker_codes: [],
    eligibility_policy_version: 'universal-v1-eligibility-1.0.0',
    eligibility_evaluated_at: at,
    eligibility_valid_until: '2026-09-24T13:00:00.000Z',
    invitation_id: ids.invitation,
    invitation_quote_id: ids.quote,
    invitation_expected_draft_version: 4,
    invitation_expected_quote_version: 1,
    invitation_is_current: true,
    invitation_valid_until: '2026-09-24T13:00:00.000Z',
    invitation_created_at: at,
    estimate_id: ids.estimate,
    estimate_quote_id: ids.quote,
    estimate_quote_version_id: ids.quoteVersion,
    estimate_version: 1,
    estimate_work_category: 'plumbing',
    estimate_customer_total_cents: '15000',
    estimate_provider_payout_cents: '12000',
    estimate_currency: 'USD',
    estimate_scope_snapshot: {
      title: 'Licensed sink repair estimate',
      description: 'Repair the leaking kitchen sink with licensed plumbing work.',
      requirements: 'Customer clears the cabinet before arrival.',
      checklist: ['Inspect leak', 'Repair approved scope'],
      work_category_code: 'plumbing',
      region_code: 'US-CA',
      rough_location: 'Oakland, CA',
      risk_level: 'IN_HOME',
      requires_proof: true,
    },
    estimate_line_items: [{
      description: 'Licensed plumbing repair',
      quantity: 1,
      unit_amount_cents: 15_000,
      total_amount_cents: 15_000,
    }],
    estimate_created_at: at,
    acceptance_id: ids.acceptance,
    acceptance_created_at: at,
    task_id: ids.task,
    task_state: 'OPEN',
    task_category: 'plumbing',
    task_risk_level: 'IN_HOME',
    task_requires_proof: true,
    task_universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
    task_automation_classification: 'CONTROLLED_TEST',
    task_worker_id: null,
    scope_version_id: ids.scope,
    scope_version: 1,
    scope_hash: 'a'.repeat(64),
    scope_source: 'INITIAL',
    scope_customer_total_cents: '15000',
    scope_provider_payout_cents: '12000',
    scope_currency: 'USD',
    scope_title: 'Licensed sink repair estimate',
    scope_description: 'Repair the leaking kitchen sink with licensed plumbing work.',
    scope_requirements: 'Customer clears the cabinet before arrival.',
    scope_checklist: ['Inspect leak', 'Repair approved scope'],
    scope_created_at: at,
    interest_id: ids.interest,
    interest_status: 'pending',
    interest_created_at: at,
    hold_id: ids.hold,
    hold_is_active: true,
    hold_status: 'ACTIVE',
    hold_reserved_at: at,
    hold_expires_at: '2026-09-24T12:15:00.000Z',
    work_order_id: ids.workOrder,
    work_order_materialization_version: 1,
    work_order_materialized_at: at,
    latest_amendment_id: null,
    latest_amendment_version: null,
    latest_financial_version: 1,
    change_order_timeline: [],
    execution_fact_id: ids.execution,
    execution_version: 1,
    execution_state: 'MATERIALIZED',
    execution_transition: 'MATERIALIZED',
    execution_recorded_at: at,
    completion_fact_id: null,
    completion_version: null,
    completion_kind: null,
    completion_created_at: null,
    completion_delivery_event_id: null,
    completion_delivery_channel: null,
    completion_delivered_at: null,
    terminal_intent_id: null,
    terminal_path: null,
    terminal_materialized_at: null,
    reconciliation_id: null,
    reconciliation_version: null,
    reconciliation_void_state: null,
    reconciliation_capture_state: null,
    reconciliation_refund_state: null,
    reconciliation_reversal_state: null,
    reconciliation_settlement_state: null,
    reconciliation_funding_state: null,
    reconciliation_provider_release_state: null,
    reconciliation_payout_state: null,
    reconciliation_bank_settlement_state: null,
    reconciliation_ledger_state: null,
    reconciliation_state: null,
    reconciliation_mismatch_codes: null,
    reconciliation_created_at: null,
    ...overrides,
  };
}

function facts(result: RawUniversalV1OccurrenceRow | null = row()) {
  return {
    loadCustomer: vi.fn().mockResolvedValue(result),
    loadProvider: vi.fn().mockResolvedValue(result),
  } satisfies UniversalV1OccurrenceFactReader;
}

function auditedOperationsReader(
  result: RawUniversalV1OccurrenceRow | null = row(),
): PostgresUniversalV1OperationsOccurrenceReader {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('assert_universal_v1_ops_case_operator_v1')) {
      return { rows: [{ actor_role: 'support' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.universal_v1_occurrence_access_audit')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: result ? [result] : [], rowCount: result ? 1 : 0 };
  }) as unknown as QueryFn;
  const transaction = vi.fn(async (operation: (txQuery: QueryFn) => Promise<unknown>) => (
    operation(query)
  )) as unknown as Database['transaction'];
  return new PostgresUniversalV1OperationsOccurrenceReader(transaction);
}

function occurrenceApplication(
  result: RawUniversalV1OccurrenceRow | null = row(),
): UniversalV1OccurrenceReadApplication {
  return new UniversalV1OccurrenceReadApplication(facts(result), auditedOperationsReader(result));
}

function readOperations(
  application: UniversalV1OccurrenceReadApplication,
): ReturnType<UniversalV1OccurrenceReadApplication['operationsAudited']> {
  return application.operationsAudited(ids.draft, ids.customer, operationsPurpose);
}

function changeOrderEntry(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: ids.proposal,
    proposal_version: 1,
    status: 'PENDING',
    change_order_kind: 'PRICE_AND_SCOPE',
    proposer_party: 'PROVIDER',
    supersedes_proposal_id: null,
    base_scope_version_id: ids.scope,
    base_scope_version: 1,
    observed_scope_summary: 'Customer approved replacement supply line work.',
    proposed_scope_sha256: 'b'.repeat(64),
    proposed_scope: {
      title: 'Licensed sink and supply line repair',
      description: 'Repair the sink and replace the newly discovered failed supply line.',
      requirements: 'Customer keeps the cabinet clear during repair.',
      checklist: ['Inspect supply line', 'Replace failed line', 'Test repair'],
    },
    proposed_customer_total_cents: 18_000,
    proposed_provider_payout_cents: 14_000,
    created_at: at,
    approvals: [],
    materialization_state: 'NOT_PREPARED',
    amendment_id: null,
    amendment_version: null,
    amendment_scope_version_id: null,
    amendment_scope_version: null,
    ...overrides,
  };
}

function activeUser(id = ids.customer, isAdmin = false) {
  return {
    id,
    is_admin: isAdmin,
    is_banned: false,
    account_status: 'ACTIVE',
    default_mode: 'poster',
  } as const;
}

function context(user: ReturnType<typeof activeUser> | null) {
  return {
    user,
    firebaseUid: user ? `firebase-${user.id}` : null,
    ip: '203.0.113.20',
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe('Universal V1 occurrence projection', () => {
  it('keeps customer-visible payout private while showing the authoring provider its full quote economics', async () => {
    const source = {
      ...row(),
      exact_address: '123 Private Street',
      private_evidence: { image: 'secret.jpg' },
      processor_reference: 'pi_secret',
      credential_number: 'CA-SECRET-1234',
      credential_evidence: { privateDocument: 'license.pdf' },
      verified_by: ids.customer,
      google_reputation: { rating: 5 },
    } as RawUniversalV1OccurrenceRow;
    const testFacts = facts(source);
    const application = new UniversalV1OccurrenceReadApplication(
      testFacts,
      auditedOperationsReader(source),
    );

    const customer = await application.customer(ids.draft, ids.customer);
    expect(customer.provider).toEqual({ provider_class: 'VERIFIED_TRADE_BUSINESS' });
    expect(customer.estimate).toMatchObject({ customer_total_cents: 15_000 });
    expect(customer.estimate).not.toHaveProperty('provider_payout_cents');
    expect(customer.scope).not.toHaveProperty('provider_payout_cents');
    expect(customer.commercial.estimate.submission?.line_items).toHaveLength(1);

    const provider = await application.provider(ids.draft, ids.provider);
    expect(provider.provider).toMatchObject({
      provider_user_id: ids.provider,
      provider_organization_id: ids.organization,
    });
    expect(provider.estimate).toMatchObject({
      customer_total_cents: 15_000,
      provider_payout_cents: 12_000,
    });
    expect(provider.scope).toMatchObject({
      customer_total_cents: 15_000,
      provider_payout_cents: 12_000,
    });
    expect(provider.commercial.estimate.submission?.line_items).toHaveLength(1);

    const operations = await readOperations(application);
    expect(operations.estimate).toMatchObject({
      customer_total_cents: 15_000,
      provider_payout_cents: 12_000,
    });
    expect(operations.commercial.estimate.submission?.line_items).toHaveLength(1);
    expect(operations).toMatchObject({
      payment_creation_frozen: true,
      hard_assignment_created: false,
      final_availability_confirmation_required: true,
    });
    for (const output of [customer, provider, operations]) {
      expect(output.commercial.trade_qualification).toEqual({
        provider_class: 'VERIFIED_TRADE_BUSINESS',
        credential_type: 'PLUMBING_LICENSE',
        issuing_authority: 'California Contractors State License Board',
        jurisdiction_code: 'US-CA',
        license_scope: 'Residential plumbing repair and installation',
        license_status: 'ACTIVE',
        expires_at: '2027-09-24T12:00:00.000Z',
        verified_at: at,
        official_source_checked_at: at,
        permitted_work_categories: ['plumbing'],
      });
    }
    expect(JSON.stringify({ customer, provider, operations })).not.toMatch(
      /123 Private Street|secret\.jpg|pi_secret|CA-SECRET-1234|license\.pdf|exact_address|private_evidence|processor_reference|credential_number|credential_evidence|verified_by|google_reputation/u,
    );
    expect(JSON.stringify({ customer, provider, operations })).not.toMatch(
      /scope_hash|sha256/u,
    );

    const noCredentialBinding = await new UniversalV1OccurrenceReadApplication(facts(row({
      qualification_provider_class: null,
      qualification_credential_type: null,
      qualification_issuing_authority: null,
      qualification_jurisdiction_code: null,
      qualification_license_scope: null,
      qualification_license_status: null,
      qualification_expires_at: null,
      qualification_verified_at: null,
      qualification_official_source_checked_at: null,
      qualification_permitted_work_categories: null,
    }))).customer(ids.draft, ids.customer);
    expect(noCredentialBinding.provider).toEqual({
      provider_class: 'VERIFIED_TRADE_BUSINESS',
    });
    expect(noCredentialBinding.commercial.trade_qualification).toBeNull();
  });

  it('projects exact estimate command observations without granting command authority', async () => {
    const pendingAcceptance = row({
      acceptance_id: null,
      acceptance_created_at: null,
    });
    const customer = await new UniversalV1OccurrenceReadApplication(facts(pendingAcceptance))
      .customer(ids.draft, ids.customer);
    expect(customer.commercial).toMatchObject({
      authority: {
        source: 'POSTGRESQL_DURABLE_FACTS',
        read_model_only: true,
        command_authority_granted: false,
        command_rechecks_current_authority: true,
      },
      estimate: {
        submission: {
          provider_estimate_submission_id: ids.estimate,
          customer_total_cents: 15_000,
          scope: { title: 'Licensed sink repair estimate' },
          line_items: [{ total_amount_cents: 15_000 }],
        },
        observed_command_context: {
          accept_provider_estimate: {
            provider_estimate_submission_id: ids.estimate,
            expected_draft_version: 4,
            expected_quote_version: 1,
          },
        },
      },
      payment_creation_frozen: true,
      fake_finance_only: true,
      hard_assignment_created: false,
    });
    expect(customer.commercial.estimate.submission).not.toHaveProperty(
      'provider_payout_cents',
    );

    const invitationOnly = row({
      estimate_id: null,
      estimate_quote_id: null,
      estimate_quote_version_id: null,
      estimate_version: null,
      estimate_work_category: null,
      estimate_customer_total_cents: null,
      estimate_provider_payout_cents: null,
      estimate_currency: null,
      estimate_scope_snapshot: null,
      estimate_line_items: null,
      estimate_created_at: null,
      acceptance_id: null,
      acceptance_created_at: null,
    });
    const provider = await new UniversalV1OccurrenceReadApplication(facts(invitationOnly))
      .provider(ids.draft, ids.provider);
    expect(provider.commercial.estimate.observed_command_context).toMatchObject({
      submit_provider_estimate: {
        quote_id: ids.quote,
        expected_draft_version: 4,
        expected_quote_version: 1,
      },
      accept_provider_estimate: null,
      issue_provider_estimate_invitation: null,
    });

    const eligibilityOnly = row({
      invitation_id: null,
      invitation_quote_id: null,
      invitation_expected_draft_version: null,
      invitation_expected_quote_version: null,
      invitation_is_current: null,
      invitation_valid_until: null,
      invitation_created_at: null,
      estimate_id: null,
      estimate_quote_id: null,
      estimate_quote_version_id: null,
      estimate_version: null,
      estimate_work_category: null,
      estimate_customer_total_cents: null,
      estimate_provider_payout_cents: null,
      estimate_currency: null,
      estimate_scope_snapshot: null,
      estimate_line_items: null,
      estimate_created_at: null,
      acceptance_id: null,
      acceptance_created_at: null,
      route_outcome: 'ESTIMATE_REQUIRED',
    });
    const operations = await readOperations(occurrenceApplication(eligibilityOnly));
    expect(operations.commercial.estimate.observed_command_context)
      .toMatchObject({
        issue_provider_estimate_invitation: {
          eligibility_decision_id: ids.eligibility,
          expected_draft_version: 4,
          expected_eligibility_version: 2,
        },
        submit_provider_estimate: null,
        accept_provider_estimate: null,
      });
  });

  it('shows provider-authored change-order quote economics while protecting customer-only payout data', async () => {
    const customerApproval = {
      approver_party: 'CUSTOMER',
      decision: 'APPROVED',
      reason: 'The revised scope and price are acceptable.',
      decided_at: at,
    };
    const providerApproval = {
      approver_party: 'PROVIDER',
      decision: 'APPROVED',
      reason: 'The provider can complete the revised scope.',
      decided_at: at,
    };
    const dualApprovalRow = row({
      change_order_timeline: [changeOrderEntry({
        approvals: [customerApproval, providerApproval],
      })],
    });
    const customer = await new UniversalV1OccurrenceReadApplication(facts(dualApprovalRow))
      .customer(ids.draft, ids.customer);
    expect(customer.commercial.change_orders).toMatchObject({
      current_scope: {
        customer_total_cents: 15_000,
        version: 1,
      },
      timeline: [{
        proposed_customer_total_cents: 18_000,
        materialization: { state: 'NOT_PREPARED' },
      }],
      observed_command_context: {
        propose_change_order: null,
        decide_change_order: null,
        authorize_and_materialize_fake_change_order: {
          proposal_id: ids.proposal,
          expected_proposal_version: 1,
          expected_scope_version: 1,
          expected_amendment_version: 0,
          expected_execution_version: 1,
          expected_financial_version: 1,
        },
      },
    });
    expect(customer.commercial.change_orders?.current_scope).not.toHaveProperty(
      'provider_payout_cents',
    );
    expect(customer.commercial.change_orders?.timeline[0]).not.toHaveProperty(
      'proposed_provider_payout_cents',
    );
    expect(customer.commercial.change_orders?.current_scope).not.toHaveProperty(
      'scope_sha256',
    );
    expect(customer.commercial.change_orders?.timeline[0]).not.toHaveProperty(
      'proposed_scope_sha256',
    );

    const provider = await new UniversalV1OccurrenceReadApplication(facts(row({
      change_order_timeline: [changeOrderEntry({ approvals: [customerApproval] })],
    }))).provider(ids.draft, ids.provider);
    expect(provider.commercial.change_orders).toMatchObject({
      current_scope: {
        customer_total_cents: 15_000,
        provider_payout_cents: 12_000,
      },
      timeline: [{
        proposed_customer_total_cents: 18_000,
        proposed_provider_payout_cents: 14_000,
      }],
      observed_command_context: {
        decide_change_order: {
          proposal_id: ids.proposal,
          expected_proposal_version: 1,
        },
        authorize_and_materialize_fake_change_order: null,
      },
    });
    const operations = await readOperations(occurrenceApplication(dualApprovalRow));
    for (const projection of [customer, provider, operations]) {
      expect(JSON.stringify(projection)).not.toMatch(/scope_hash|sha256/u);
      expect(JSON.stringify(projection.commercial)).not.toContain(
        'The revised scope and price are acceptable.',
      );
      expect(JSON.stringify(projection.commercial)).not.toContain(
        'Customer approved replacement supply line work.',
      );
    }
  });

  it('suppresses change-order materialization during prepared recovery and fails closed on corrupt commercial facts', async () => {
    const customerApproval = {
      approver_party: 'CUSTOMER', decision: 'APPROVED', reason: 'Approved.', decided_at: at,
    };
    const providerApproval = {
      approver_party: 'PROVIDER', decision: 'APPROVED', reason: 'Approved.', decided_at: at,
    };
    const prepared = await new UniversalV1OccurrenceReadApplication(facts(row({
      change_order_timeline: [changeOrderEntry({
        status: 'APPROVED',
        approvals: [customerApproval, providerApproval],
        materialization_state: 'PREPARED_RECOVERING',
      })],
    }))).customer(ids.draft, ids.customer);
    expect(prepared.commercial.change_orders?.observed_command_context).toEqual({
      propose_change_order: null,
      decide_change_order: null,
      authorize_and_materialize_fake_change_order: null,
    });

    await expect(new UniversalV1OccurrenceReadApplication(facts(row({
      estimate_line_items: [{
        description: 'Invalid total',
        quantity: 2,
        unit_amount_cents: 5_000,
        total_amount_cents: 5_000,
      }],
    }))).customer(ids.draft, ids.customer)).rejects.toMatchObject({
      code: 'OCCURRENCE_READ_UNAVAILABLE',
    });

    for (const brokenBoundary of [
      { task_universal_payment_posture: 'PAYMENT_CREATION_ENABLED' },
      { task_automation_classification: 'PRODUCTION' },
      { task_worker_id: ids.provider },
    ]) {
      await expect(new UniversalV1OccurrenceReadApplication(facts(row(brokenBoundary)))
        .customer(ids.draft, ids.customer)).rejects.toMatchObject({
        code: 'OCCURRENCE_READ_UNAVAILABLE',
      });
    }
  });

  it('derives next_action deterministically from the latest durable stage and perspective', async () => {
    const estimateRow = row({
      route_outcome: 'ESTIMATE_REQUIRED',
      acceptance_id: null,
      acceptance_created_at: null,
      task_id: null,
      task_state: null,
      task_category: null,
      task_risk_level: null,
      task_requires_proof: null,
      task_universal_payment_posture: null,
      task_automation_classification: null,
      task_worker_id: null,
      scope_version_id: null,
      scope_version: null,
      scope_hash: null,
      scope_source: null,
      scope_customer_total_cents: null,
      scope_provider_payout_cents: null,
      scope_currency: null,
      scope_created_at: null,
      interest_id: null,
      interest_status: null,
      interest_created_at: null,
      hold_id: null,
      hold_status: null,
      hold_reserved_at: null,
      hold_expires_at: null,
      work_order_id: null,
      work_order_materialization_version: null,
      work_order_materialized_at: null,
      execution_fact_id: null,
      execution_version: null,
      execution_state: null,
      execution_transition: null,
      execution_recorded_at: null,
    });
    const estimateFacts = facts(estimateRow);
    const estimateApplication = new UniversalV1OccurrenceReadApplication(
      estimateFacts,
      auditedOperationsReader(estimateRow),
    );
    await expect(estimateApplication.customer(ids.draft, ids.customer))
      .resolves.toMatchObject({ next_action: 'REVIEW_ESTIMATE' });
    await expect(estimateApplication.provider(ids.draft, ids.provider))
      .resolves.toMatchObject({ next_action: 'WAIT_FOR_ESTIMATE_DECISION' });
    await expect(readOperations(estimateApplication))
      .resolves.toMatchObject({ next_action: 'MONITOR_CUSTOMER_DECISION' });

    const executionApplication = new UniversalV1OccurrenceReadApplication(facts(row()));
    await expect(executionApplication.provider(ids.draft, ids.provider))
      .resolves.toMatchObject({ next_action: 'ACKNOWLEDGE_WORK_ORDER' });
    await expect(executionApplication.customer(ids.draft, ids.customer))
      .resolves.toMatchObject({ next_action: 'TRACK_WORK_ORDER' });

    const blockedEligibility = occurrenceApplication(row({
      route_outcome: 'ESTIMATE_REQUIRED',
      eligibility_task_eligible: false,
      eligibility_blocker_codes: ['CREDENTIAL_REQUIRED'],
      invitation_id: null,
      invitation_is_current: null,
      invitation_valid_until: null,
      invitation_created_at: null,
      estimate_id: null,
      estimate_quote_id: null,
      estimate_quote_version_id: null,
      estimate_version: null,
      estimate_work_category: null,
      estimate_customer_total_cents: null,
      estimate_provider_payout_cents: null,
      estimate_currency: null,
      estimate_created_at: null,
      acceptance_id: null,
      acceptance_created_at: null,
    }));
    await expect(blockedEligibility.provider(ids.draft, ids.provider))
      .resolves.toMatchObject({ next_action: 'RESOLVE_ELIGIBILITY_BLOCKERS' });
    await expect(readOperations(blockedEligibility))
      .resolves.toMatchObject({ next_action: 'ESTABLISH_ELIGIBILITY' });

    const expiredHold = new UniversalV1OccurrenceReadApplication(facts(row({
      hold_status: 'EXPIRED',
      hold_is_active: false,
      work_order_id: null,
      work_order_materialization_version: null,
      work_order_materialized_at: null,
      execution_fact_id: null,
      execution_version: null,
      execution_state: null,
      execution_transition: null,
      execution_recorded_at: null,
    })));
    await expect(expiredHold.customer(ids.draft, ids.customer))
      .resolves.toMatchObject({ next_action: 'REVIEW_PROVIDER_INTEREST' });
    await expect(expiredHold.provider(ids.draft, ids.provider))
      .resolves.toMatchObject({ next_action: 'WAIT_FOR_CUSTOMER_HOLD' });
  });

  it('does not report completion before the terminal fake lifecycle reconciles', async () => {
    const approved = {
      completion_fact_id: ids.completion,
      completion_version: 2,
      completion_kind: 'APPROVED',
      completion_created_at: at,
      execution_state: 'COMPLETED',
    } as const;
    const awaitingFinance = occurrenceApplication(row(approved));
    await expect(awaitingFinance.customer(ids.draft, ids.customer)).resolves.toMatchObject({
      next_action: 'WAIT_FOR_FINANCIAL_COMPLETION',
      financial_lifecycle: null,
    });
    await expect(readOperations(awaitingFinance)).resolves.toMatchObject({
      next_action: 'COMPLETE_FAKE_FINANCIAL_LIFECYCLE',
    });

    const mismatch = occurrenceApplication(row({
      ...approved,
      terminal_intent_id: ids.terminalIntent,
      terminal_path: 'SETTLED',
      terminal_materialized_at: at,
      reconciliation_id: ids.reconciliation,
      reconciliation_version: 1,
      reconciliation_void_state: 'NOT_APPLICABLE',
      reconciliation_capture_state: 'CAPTURED',
      reconciliation_refund_state: 'NOT_APPLICABLE',
      reconciliation_reversal_state: 'NOT_APPLICABLE',
      reconciliation_settlement_state: 'SETTLED',
      reconciliation_funding_state: 'FUNDED',
      reconciliation_provider_release_state: 'RELEASED',
      reconciliation_payout_state: 'PAID',
      reconciliation_bank_settlement_state: 'SETTLED',
      reconciliation_ledger_state: 'MISMATCH',
      reconciliation_state: 'MISMATCH',
      reconciliation_mismatch_codes: ['LEDGER_AMOUNT_MISMATCH'],
      reconciliation_created_at: at,
    }));
    await expect(mismatch.customer(ids.draft, ids.customer)).resolves.toMatchObject({
      next_action: 'WAIT_FOR_RECONCILIATION',
      financial_lifecycle: {
        terminal_path: 'SETTLED',
        reconciliation: {
          state: 'MISMATCH',
          mismatch_codes: ['LEDGER_AMOUNT_MISMATCH'],
        },
      },
    });
    await expect(readOperations(mismatch)).resolves.toMatchObject({
      next_action: 'RESOLVE_RECONCILIATION_MISMATCH',
    });

    const matched = new UniversalV1OccurrenceReadApplication(facts(row({
      ...approved,
      terminal_intent_id: ids.terminalIntent,
      terminal_path: 'SETTLED',
      terminal_materialized_at: at,
      reconciliation_id: ids.reconciliation,
      reconciliation_version: 1,
      reconciliation_void_state: 'NOT_APPLICABLE',
      reconciliation_capture_state: 'CAPTURED',
      reconciliation_refund_state: 'NOT_APPLICABLE',
      reconciliation_reversal_state: 'NOT_APPLICABLE',
      reconciliation_settlement_state: 'SETTLED',
      reconciliation_funding_state: 'FUNDED',
      reconciliation_provider_release_state: 'RELEASED',
      reconciliation_payout_state: 'PAID',
      reconciliation_bank_settlement_state: 'SETTLED',
      reconciliation_ledger_state: 'MATCHED',
      reconciliation_state: 'MATCHED',
      reconciliation_mismatch_codes: [],
      reconciliation_created_at: at,
    })));
    await expect(matched.provider(ids.draft, ids.provider)).resolves.toMatchObject({
      next_action: 'OCCURRENCE_COMPLETE',
    });
  });

  it('projects the server-bound completion delivery receipt to customer and Operations only', async () => {
    const submitted = row({
      execution_state: 'COMPLETION_SUBMITTED',
      completion_fact_id: ids.completion,
      completion_version: 1,
      completion_kind: 'SUBMITTED',
      completion_created_at: at,
      completion_delivery_event_id: ids.completionDelivery,
      completion_delivery_channel: 'EMAIL',
      completion_delivered_at: at,
    });
    const application = occurrenceApplication(submitted);

    await expect(application.customer(ids.draft, ids.customer)).resolves.toMatchObject({
      next_action: 'DECIDE_COMPLETION',
      completion: {
        completion_fact_id: ids.completion,
        delivery_receipt: {
          delivery_event_id: ids.completionDelivery,
          status: 'DELIVERED',
          channel: 'EMAIL',
          delivered_at: at,
        },
      },
    });
    await expect(readOperations(application)).resolves.toMatchObject({
      completion: {
        delivery_receipt: { delivery_event_id: ids.completionDelivery },
      },
    });
    await expect(application.provider(ids.draft, ids.provider)).resolves.not.toHaveProperty(
      'completion.delivery_receipt',
    );
  });

  it('does not invite a customer completion decision before delivery evidence exists', async () => {
    const application = new UniversalV1OccurrenceReadApplication(facts(row({
      execution_state: 'COMPLETION_SUBMITTED',
      completion_fact_id: ids.completion,
      completion_version: 1,
      completion_kind: 'SUBMITTED',
      completion_created_at: at,
    })));

    const customer = await application.customer(ids.draft, ids.customer);
    expect(customer).toMatchObject({ next_action: 'WAIT_FOR_COMPLETION_NOTICE' });
    expect(customer).not.toHaveProperty('completion.delivery_receipt');
  });

  it('collapses missing authority and database failures to opaque public errors', async () => {
    const missing = new UniversalV1OccurrenceReadApplication(facts(null));
    await expect(missing.provider(ids.draft, ids.provider)).rejects.toMatchObject({
      code: 'OCCURRENCE_NOT_FOUND',
      message: expect.not.stringContaining(ids.draft),
    });

    const failing = facts();
    failing.loadCustomer.mockRejectedValueOnce(new Error('private_database_password'));
    const unavailable = new UniversalV1OccurrenceReadApplication(failing);
    await expect(unavailable.customer(ids.draft, ids.customer)).rejects.toMatchObject({
      code: 'OCCURRENCE_READ_UNAVAILABLE',
      message: expect.not.stringContaining('private_database_password'),
    });
  });
});

describe('PostgreSQL Universal V1 occurrence authority', () => {
  it('does not expose unaudited Operations methods on application or fact-reader prototypes', () => {
    expect(Object.getOwnPropertyNames(UniversalV1OccurrenceReadApplication.prototype))
      .not.toContain('operations');
    expect(Object.getOwnPropertyNames(PostgresUniversalV1OccurrenceFactReader.prototype))
      .not.toContain('loadOperations');
  });

  it('uses customer ownership and explicit-column reads without private or processor fields', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()], rowCount: 1 });
    const reader = new PostgresUniversalV1OccurrenceFactReader(query as QueryFn);
    await reader.loadCustomer(ids.draft, ids.customer);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ids.draft, ids.customer]);
    expect(sql).toContain('draft.poster_user_id = $2');
    expect(sql).toContain('draft.universal_contract_version = 1');
    expect(sql).toContain('draft.active_routing_decision_id');
    expect(sql).toContain('public.current_verified_trade_qualifications');
    expect(sql).toContain(
      'qualification.business_credential_id = eligibility.trade_credential_id',
    );
    expect(sql).not.toMatch(/SELECT\s+\*/iu);
    expect(sql).toContain('delivery.expected_completion_fact_id = CASE');
    expect(sql).toContain("WHEN completion.fact_kind = 'APPROVED'");
    expect(sql).not.toMatch(
      /task\.location|raw_input|structured|eligibility\.evidence|proof_id|proof_snapshot|proofs?\.|external_reference|stripe_|pay_token/iu,
    );
    expect(sql).not.toMatch(
      /credential_evidence|evidence_hash|verified_by|credential_number|google_reputation/iu,
    );
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('requires the exact provider identity or scoped organization membership and filters its chain', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()], rowCount: 1 });
    const reader = new PostgresUniversalV1OccurrenceFactReader(query as QueryFn);
    await reader.loadProvider(ids.draft, ids.provider);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([ids.draft, ids.provider]);
    expect(sql).toContain('candidate.provider_user_id = $2');
    expect(sql).toContain('public.business_membership_has_action(');
    expect(sql).toContain("'SUBMIT_ESTIMATE'");
    expect(sql).toContain('WHERE provider_key.provider_user_id IS NOT NULL');
    expect(sql).toContain('eligibility.provider_user_id = provider_key.provider_user_id');
    expect(sql).toContain('IS NOT DISTINCT FROM');
  });

  it('rechecks the named operator and appends the exact projection digest in one transaction', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('assert_universal_v1_ops_case_operator_v1')) {
        return { rows: [{ actor_role: 'support' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.universal_v1_occurrence_access_audit')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [row()], rowCount: 1 };
    }) as unknown as QueryFn;
    const transaction = vi.fn(async (operation: (txQuery: QueryFn) => Promise<unknown>) => (
      operation(query)
    )) as unknown as Database['transaction'];
    const reader = new PostgresUniversalV1OperationsOccurrenceReader(transaction);

    const observed = await reader.read(
      ids.draft,
      ids.customer,
      'Investigate the exact occurrence state for a named support case.',
    );
    expect(observed).toMatchObject({ perspective: 'OPERATIONS', task_draft_id: ids.draft });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ params: [ids.customer] });
    expect(calls[0]!.sql).toContain('assert_universal_v1_ops_case_operator_v1');
    const audit = calls.at(-1)!;
    expect(audit.sql).toContain('universal_v1_occurrence_access_audit');
    expect(audit.params).toEqual([
      ids.draft,
      ids.customer,
      'support',
      'Investigate the exact occurrence state for a named support case.',
      universalV1OccurrenceProjectionSha256(observed!),
    ]);
  });

  it('returns no Operations projection when the audit transaction fails', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ actor_role: 'support' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit insert unavailable')) as unknown as QueryFn;
    const transaction = vi.fn(async (operation: (txQuery: QueryFn) => Promise<unknown>) => (
      operation(query)
    )) as unknown as Database['transaction'];
    const operationsReader = new PostgresUniversalV1OperationsOccurrenceReader(transaction);
    const application = new UniversalV1OccurrenceReadApplication(facts(), operationsReader);
    await expect(application.operationsAudited(
      ids.draft,
      ids.customer,
      'Investigate the exact occurrence state for a named support case.',
    )).rejects.toMatchObject({ code: 'OCCURRENCE_READ_UNAVAILABLE' });
  });

  it('fails closed when no audited Operations reader is configured', async () => {
    const application = new UniversalV1OccurrenceReadApplication(facts());
    await expect(readOperations(application)).rejects.toMatchObject({
      code: 'OCCURRENCE_READ_UNAVAILABLE',
    });
  });
});

describe('Universal V1 occurrence tRPC authorization', () => {
  it('requires authentication and forwards only authenticated actor identity', async () => {
    const testFacts = facts();
    const api = createUniversalOccurrenceRouter(
      new UniversalV1OccurrenceReadApplication(testFacts),
    );

    await expect(api.createCaller(context(null)).customer({ task_draft_id: ids.draft }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(api.createCaller(context(null)).provider({ task_draft_id: ids.draft }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(testFacts.loadCustomer).not.toHaveBeenCalled();
    expect(testFacts.loadProvider).not.toHaveBeenCalled();

    await api.createCaller(context(activeUser())).customer({ task_draft_id: ids.draft });
    await api.createCaller(context(activeUser(ids.provider))).provider({ task_draft_id: ids.draft });
    expect(testFacts.loadCustomer).toHaveBeenCalledWith(ids.draft, ids.customer);
    expect(testFacts.loadProvider).toHaveBeenCalledWith(ids.draft, ids.provider);
  });

  it('returns the same opaque not-found response for an unrelated provider', async () => {
    const api = createUniversalOccurrenceRouter(
      new UniversalV1OccurrenceReadApplication(facts(null)),
    );
    await expect(api.createCaller(context(activeUser(ids.provider))).provider({
      task_draft_id: ids.draft,
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The occurrence is unavailable.',
    });
  });

  it('requires scoped Operations RBAC and fresh MFA before reading the projection', async () => {
    const testFacts = facts();
    const operationsReader = auditedOperationsReader();
    const operationsRead = vi.spyOn(operationsReader, 'read');
    const api = createUniversalOccurrenceRouter(
      new UniversalV1OccurrenceReadApplication(testFacts, operationsReader),
    );
    await expect(api.createCaller(context(activeUser(ids.customer, false))).operations({
      task_draft_id: ids.draft,
      purpose: 'Investigate the exact occurrence state for a named support case.',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(operationsRead).not.toHaveBeenCalled();

    vi.spyOn(db, 'query').mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }],
      rowCount: 1,
    });
    const now = Math.floor(Date.now() / 1_000);
    const operatorContext = {
      ...context(activeUser(ids.customer, true)),
      identityAssurance: {
        authenticatedAtSeconds: now,
        tokenExpiresAtSeconds: now + 3_600,
        signInProvider: 'password',
        secondFactor: 'phone',
        mfaVerified: true,
      },
    } as never;
    await expect(api.createCaller(operatorContext).operations({
      task_draft_id: ids.draft,
      purpose: '  Investigate the exact occurrence state for a named support case.  ',
    }))
      .resolves.toMatchObject({ perspective: 'OPERATIONS' });
    expect(operationsRead).toHaveBeenCalledWith(
      ids.draft,
      ids.customer,
      'Investigate the exact occurrence state for a named support case.',
    );
    expect(testFacts.loadCustomer).not.toHaveBeenCalled();
    expect(testFacts.loadProvider).not.toHaveBeenCalled();
  });

  it('rejects an absent or undersized Operations purpose before the audited reader', async () => {
    const operationsReader = auditedOperationsReader();
    const operationsRead = vi.spyOn(operationsReader, 'read');
    const api = createUniversalOccurrenceRouter(
      new UniversalV1OccurrenceReadApplication(facts(), operationsReader),
    );
    const now = Math.floor(Date.now() / 1_000);
    const operatorContext = {
      ...context(activeUser(ids.customer, true)),
      identityAssurance: {
        authenticatedAtSeconds: now,
        tokenExpiresAtSeconds: now + 3_600,
        signInProvider: 'password',
        secondFactor: 'phone',
        mfaVerified: true,
      },
    } as never;
    vi.spyOn(db, 'query').mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }],
      rowCount: 1,
    });
    await expect(api.createCaller(operatorContext).operations({
      task_draft_id: ids.draft,
      purpose: 'short',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(operationsRead).not.toHaveBeenCalled();
  });
});
