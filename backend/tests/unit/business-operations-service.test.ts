import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  activateBusinessServiceProfile,
  createBusinessServiceProfile,
  decideBusinessApproval,
  listBusinessApprovalQueue,
  listBusinessBudgetPolicies,
  listBusinessServiceProfiles,
  requestBusinessSpend,
  submitBusinessCredential,
  upsertBusinessBudgetPolicy,
} from '../../src/services/BusinessOperationsService.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const LOCATION = '20000000-0000-4000-8000-000000000001';
const REQUEST = '30000000-0000-4000-8000-000000000001';
const PROFILE = '40000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '50000000-0000-4000-8000-000000000001';

describe('business operations service boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates budget enforcement to the actor-bound database authority', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ policy_id: REQUEST, policy_revision: 2 }] });
    const result = await upsertBusinessBudgetPolicy({
      actorId: ACTOR, organizationId: ORG, locationId: LOCATION,
      serviceCategory: 'FACILITIES', perTaskCapCents: 20_000,
      monthlyCapCents: 100_000, autoApproveLimitCents: 10_000,
      poRequired: true, costCenterRequired: true,
    });
    expect(result).toEqual({ success: true, data: { id: REQUEST, revision: 2 } });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      ORG, ACTOR, LOCATION, 'FACILITIES', 20_000, 100_000, 10_000, true, true,
    ]);
  });

  it('lists budget policies only through VIEW_BILLING authority', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: REQUEST, location_id: null, service_category: '*', per_task_cap_cents: '20000',
      monthly_cap_cents: '100000', auto_approve_limit_cents: '10000',
      po_required: false, cost_center_required: false, revision: 1,
    }] });
    const result = await listBusinessBudgetPolicies(ACTOR, ORG);
    expect(result).toMatchObject({ success: true, data: [{ monthlyCapCents: 100_000 }] });
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("'VIEW_BILLING'");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ORG, ACTOR]);
  });

  it('returns the database-derived spend outcome and blockers', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      approval_request_id: REQUEST,
      approval_status: 'BLOCKED',
      approval_blockers: ['PER_TASK_CAP_EXCEEDED'],
    }] });
    const result = await requestBusinessSpend({
      actorId: ACTOR, organizationId: ORG, locationId: LOCATION,
      serviceCategory: 'FACILITIES', amountCents: 25_000,
      poNumber: 'PO-100', costCenter: 'OPS', idempotencyKey: 'spend:test:001',
    });
    expect(result).toEqual({ success: true, data: {
      id: REQUEST, status: 'BLOCKED', blockers: ['PER_TASK_CAP_EXCEEDED'],
    } });
    expect(mocks.query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual([ORG, ACTOR]);
  });

  it('keeps approval queue identity minimal and maps self-approval denial', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: REQUEST, requester_name: 'Alex Requester', location_id: LOCATION,
      location_name: 'Bellevue Store', service_category: 'FACILITIES', amount_cents: '15000',
      po_number: 'PO-101', cost_center: 'OPS', status: 'PENDING_APPROVAL', blockers: [],
      created_at: '2026-07-18T12:00:00.000Z',
    }] });
    const listed = await listBusinessApprovalQueue(ACTOR, ORG);
    expect(listed).toMatchObject({ success: true, data: [{ requesterName: 'Alex Requester' }] });
    expect(String(mocks.query.mock.calls[0]?.[0])).not.toMatch(/email|firebase/i);

    mocks.query.mockRejectedValueOnce(new Error('HXBUS26: requester cannot approve their own spend'));
    const decided = await decideBusinessApproval({
      actorId: ACTOR, organizationId: ORG, approvalRequestId: REQUEST,
      decision: 'APPROVED', reason: 'Attempted self approval',
    });
    expect(decided).toEqual({ success: false, error: {
      code: 'BUSINESS_SELF_APPROVAL_DENIED',
      message: 'A requester cannot approve their own spend.',
    } });
  });

  it('creates provider supply as draft without accepting readiness state', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ service_profile_id: PROFILE, profile_status: 'DRAFT' }] });
    const result = await createBusinessServiceProfile({
      actorId: ACTOR, organizationId: ORG, serviceCode: 'ELECTRICAL',
      serviceName: 'Commercial electrical',
      serviceDescription: 'Qualified electrical response with proof.',
      serviceExclusions: [], bookingQuestions: ['What failed?'],
      coveragePostalCodes: ['98004'], maximumTravelMiles: 20, weeklyCapacitySlots: 12,
      blackoutDates: [], pricingMode: 'INSTANT_CORRIDOR', corridorMinimumCents: 9_000,
      corridorMaximumCents: 14_000, responseMode: 'INDIVIDUAL_OFFERS',
      proofChecklist: ['Upload final proof'], credentialRequirements: ['ELECTRICAL_LICENSE'],
      idempotencyKey: 'service:electrical:001',
    });
    expect(result).toEqual({ success: true, data: { id: PROFILE, status: 'DRAFT' } });
    const parameters = mocks.query.mock.calls[0]?.[1] as unknown[];
    expect(parameters).not.toContain('ACTIVE');
    expect(parameters.slice(0, 2)).toEqual([ORG, ACTOR]);
  });

  it('lists truthful service status and the latest activation blockers', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: PROFILE, service_code: 'ELECTRICAL', service_name: 'Electrical',
      service_description: 'Commercial electrical response.', service_exclusions: [],
      booking_questions: [], coverage_postal_codes: ['98004'], maximum_travel_miles: 20,
      weekly_capacity_slots: 12, blackout_dates: [], pricing_mode: 'QUOTE_REQUIRED',
      corridor_minimum_cents: null, corridor_maximum_cents: null,
      response_mode: 'INDIVIDUAL_OFFERS', proof_checklist: ['Final proof'],
      credential_requirements: ['ELECTRICAL_LICENSE'], status: 'DRAFT',
      assigned_crew_count: '1', last_activation_blockers: ['PAYOUT_NOT_ACTIVE'],
    }] });
    const result = await listBusinessServiceProfiles(ACTOR, ORG);
    expect(result).toMatchObject({ success: true, data: [{
      status: 'DRAFT', assignedCrewCount: 1,
      lastActivationBlockers: ['PAYOUT_NOT_ACTIVE'],
    }] });
  });

  it('hashes credential evidence before persistence and forces pending status', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ credential_id: REQUEST, credential_status: 'PENDING' }] });
    const result = await submitBusinessCredential({
      actorId: ACTOR, organizationId: ORG, membershipId: MEMBERSHIP,
      credentialType: 'ELECTRICAL_LICENSE', evidenceReference: 'private-upload-token-123',
    });
    expect(result).toEqual({ success: true, data: { id: REQUEST, status: 'PENDING' } });
    const parameters = mocks.query.mock.calls[0]?.[1] as string[];
    expect(parameters).not.toContain('private-upload-token-123');
    expect(parameters[4]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns activation blockers as data instead of pretending the service launched', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      service_profile_id: PROFILE, ready: false,
      blockers: ['LEGAL_ENTITY_NOT_VERIFIED', 'PAYOUT_NOT_ACTIVE'],
    }] });
    const result = await activateBusinessServiceProfile({
      actorId: ACTOR, organizationId: ORG, serviceProfileId: PROFILE,
    });
    expect(result).toEqual({ success: true, data: {
      id: PROFILE, ready: false,
      blockers: ['LEGAL_ENTITY_NOT_VERIFIED', 'PAYOUT_NOT_ACTIVE'],
    } });
  });
});
