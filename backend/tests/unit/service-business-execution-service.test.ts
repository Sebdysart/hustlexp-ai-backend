import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    transaction: vi.fn(async (fn: (query: typeof mocks.query) => Promise<unknown>) => fn(mocks.query)),
  },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/services/TaskReservationService.js', () => ({
  TaskReservationService: { reserve: mocks.reserve },
}));

import {
  acceptServiceBusinessOpportunity,
  clarifyServiceBusinessOpportunity,
  declineServiceBusinessOpportunity,
  linkServiceBusinessPayoutAccount,
  listServiceBusinessOpportunities,
  quoteServiceBusinessOpportunity,
  reviewServiceBusinessOpportunity,
} from '../../src/services/ServiceBusinessExecutionService.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const PROFILE = '20000000-0000-4000-8000-000000000001';
const CREW = '30000000-0000-4000-8000-000000000001';
const WORKER = '40000000-0000-4000-8000-000000000001';
const PAYOUT = '50000000-0000-4000-8000-000000000001';
const TASK = '60000000-0000-4000-8000-000000000001';
const OFFER = '70000000-0000-4000-8000-000000000001';

function opportunityRow() {
  return {
    task_id: TASK, title: 'Storefront cleanup', description: 'Clean the approved storefront area.',
    requirements: 'Bring basic cleanup tools.', category: 'CLEANUP', customer_total_cents: 10_000,
    payout_cents: 8_500, platform_margin_cents: 1_500, estimated_duration_minutes: 120,
    required_tools: ['broom'], rough_location: 'Bellevue', risk_level: 'LOW',
    scope_hash: 'a'.repeat(64), cancellation_policy_version: 'task-template-v2:cleanup-v1',
    late_cancel_pct: 25, cancellation_window_hours: 24, deadline: '2026-07-24T18:00:00.000Z',
    service_profile_id: PROFILE, service_name: 'Commercial cleanup', maximum_travel_miles: 12,
    minimum_provider_net_hourly_cents: 2500, provider_earnings_policy_version: 'earnings-v1',
    eligible_crew_count: 2,
  };
}

describe('Service Business execution service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links payout only through the provider-backed database authority boundary', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      payout_account_id: PAYOUT, payout_recipient_user_id: ACTOR, payout_status: 'ACTIVE',
    }] });
    const result = await linkServiceBusinessPayoutAccount({
      actorId: ACTOR, organizationId: ORG, payoutMembershipId: CREW,
      idempotencyKey: 'business:payout:001',
    });
    expect(result).toEqual({ success: true, data: {
      payoutAccountId: PAYOUT, payoutRecipientUserId: ACTOR, status: 'ACTIVE',
    } });
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('link_business_provider_payout_account');
  });

  it('lists funded canonical opportunities without selecting private location or access material', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [opportunityRow()] });
    const result = await listServiceBusinessOpportunities(ACTOR, ORG);
    expect(result).toMatchObject({ success: true, data: [{
      taskId: TASK, serviceProfileId: PROFILE, payoutCents: 8500,
      travel: { maximumMiles: 12 }, eligibleCrewCount: 2,
    }] });
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("escrow.state='FUNDED'");
    expect(sql).toContain("crew_inventory.eligible_crew_count>0");
    expect(sql).toContain("profile.weekly_capacity_slots>");
    expect(sql).toContain("cell.metrics_computed_at>=NOW()-INTERVAL '15 minutes'");
    expect(sql).toContain("identity_verification_is_current_v1(fulfiller.id,'PRODUCTION')");
    expect(sql).toContain("provider_org.status='ACTIVE'");
    expect(sql).toContain('provider_org.provider_enabled=TRUE');
    expect(sql).toContain("provider_org.verification_status='VERIFIED'");
    expect(sql).not.toMatch(/exact_address|location_ciphertext|access_ciphertext/i);
  });

  it('persists a decision-complete provider offer bound to the organization and chosen crew', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [opportunityRow()] })
      .mockResolvedValueOnce({ rows: [{
        ready: true, blockers: [], payout_recipient_user_id: ACTOR,
        fulfiller_user_id: WORKER,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: OFFER, expires_at: '2026-07-23T01:00:00.000Z' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const result = await reviewServiceBusinessOpportunity({
      actorId: ACTOR, organizationId: ORG, serviceProfileId: PROFILE,
      crewAssignmentId: CREW, taskId: TASK, idempotencyKey: 'business:offer:001',
    });
    expect(result).toMatchObject({ success: true, data: {
      offerDecisionId: OFFER, decision: { decisionReady: true },
    } });
    const insert = mocks.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO worker_offer_decisions'));
    expect(insert).toBeTruthy();
    expect(String(insert?.[0])).toContain('provider_organization_id');
    expect(insert?.[1]).toEqual(expect.arrayContaining([ORG, PROFILE, CREW, ACTOR, WORKER]));
  });

  it('accepts through the canonical reservation transaction with organization, crew, offer, and payee context', async () => {
    mocks.reserve.mockResolvedValueOnce({ success: true, data: {
      reservationId: 'reservation-id', engineTaskId: TASK, hustlerRef: WORKER,
      state: 'ENGINE_RESERVED', idempotencyReplayed: false,
    } });
    const result = await acceptServiceBusinessOpportunity({
      actorId: ACTOR, organizationId: ORG, serviceProfileId: PROFILE,
      crewAssignmentId: CREW, fulfillerUserId: WORKER, offerDecisionId: OFFER,
      taskId: TASK, idempotencyKey: 'business:accept:001',
    });
    expect(result.success).toBe(true);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      engineTaskId: TASK, hustlerRef: WORKER, actorId: ACTOR,
      serviceBusiness: {
        organizationId: ORG, serviceProfileId: PROFILE, crewAssignmentId: CREW,
        offerDecisionId: OFFER,
      },
    }));
  });

  it('records a neutral decline, a public clarification, and a bounded quote as attributable actions', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ event_id: 'decline-event', replayed: false }] });
    const declined = await declineServiceBusinessOpportunity({
      actorId: ACTOR, organizationId: ORG, offerDecisionId: OFFER,
      reasonCode: 'CAPACITY_CONFLICT', idempotencyKey: 'business:decline:001',
    });
    expect(declined).toMatchObject({ success: true, data: { action: 'DECLINED' } });

    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: TASK, poster_id: 'poster-id', state: 'OPEN' }] })
      .mockResolvedValueOnce({ rows: [{ id: OFFER, worker_id: WORKER }] })
      .mockResolvedValueOnce({ rows: [{ id: 'question-id', status: 'OPEN' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ event_id: 'clarify-event', replayed: false }] });
    const clarified = await clarifyServiceBusinessOpportunity({
      actorId: ACTOR, organizationId: ORG, offerDecisionId: OFFER,
      question: 'Is loading-dock access available?', idempotencyKey: 'business:clarify:001',
    });
    expect(clarified).toMatchObject({ success: true, data: { action: 'CLARIFICATION_REQUESTED' } });

    mocks.query
      .mockResolvedValueOnce({ rows: [{ event_type: null, request_hash: null }] })
      .mockResolvedValueOnce({ rows: [{
        id: TASK, poster_id: 'poster-id', state: 'OPEN', title: 'Storefront cleanup',
        description: 'Clean the approved storefront area.', requirements: null,
        price: 10_000, hustler_payout_cents: 8_500, platform_margin_cents: 1_500,
        scope_hash: 'a'.repeat(64), active_scope_version_id: 'scope-id', clarification_state: 'READY',
      }] })
      .mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }] })
      .mockResolvedValueOnce({ rows: [{
        id: OFFER, worker_id: WORKER, provider_organization_id: ORG,
        provider_service_profile_id: PROFILE, provider_crew_assignment_id: CREW,
        customer_total_cents: 10_000, payout_cents: 8_500, scope_hash: 'a'.repeat(64),
        expires_at: '2026-07-23T01:00:00.000Z',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'scope-id', checklist: ['Clean area'] }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'counter-id', task_id: TASK, worker_id: WORKER, status: 'PENDING_POSTER',
        current_customer_total_cents: 10_000, current_payout_cents: 8_500,
        platform_margin_cents: 1_500, minimum_counter_payout_cents: 8_600,
        maximum_counter_payout_cents: 9_444, customer_maximum_cents: 12_500,
        margin_floor_bps: 1000, proposed_payout_cents: 8_600,
        proposed_customer_total_cents: 10_100, reason: 'Additional disposal handling required.',
        replacement_task_id: null, expires_at: '2026-07-23T01:00:00.000Z',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ event_id: 'quote-event', replayed: false }] });
    const quoted = await quoteServiceBusinessOpportunity({
      actorId: ACTOR, organizationId: ORG, offerDecisionId: OFFER,
      proposedPayoutCents: 8_600, reason: 'Additional disposal handling required.',
      idempotencyKey: 'business:quote:001',
    });
    expect(quoted).toMatchObject({ success: true, data: {
      action: 'QUOTED', proposedCustomerTotalCents: 10_100,
      requiresPaymentReauthorization: false,
    } });
    expect(mocks.query.mock.calls.some((call) => String(call[0]).includes('worker_counter_offers'))).toBe(true);
  });
});
