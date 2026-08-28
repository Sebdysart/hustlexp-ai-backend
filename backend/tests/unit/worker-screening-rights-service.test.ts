import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), recompute: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/services/CapabilityRecomputeService.js', () => ({ recomputeCapabilityProfile: mocks.recompute }));

import {
  WORKER_SCREENING_DISCLOSURE_VERSION,
  beginPreAdverseAction,
  finalizeAdverseAction,
  getMyScreeningRights,
  grantScreeningConsent,
  submitScreeningAppeal,
  submitScreeningDispute,
} from '../../src/services/WorkerScreeningRightsService.js';
import { WORKER_SCREENING_DISCLOSURE_HASH } from '../../src/services/WorkerScreeningRightsPolicy.js';

const check = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  provider: 'checkr',
  status: 'CONSIDER',
  result_summary: 'Reviewable provider report information',
  initiated_at: '2026-07-18T00:00:00.000Z',
  completed_at: '2026-07-18T01:00:00.000Z',
  expires_at: '2027-07-18T00:00:00.000Z',
};

describe('WorkerScreeningRightsService', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.transaction.mockReset();
    mocks.recompute.mockReset();
    mocks.transaction.mockImplementation(async (work) => work(mocks.query));
  });

  it('persists informed consent and an attributable event atomically', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'consent-1', disclosure_version: WORKER_SCREENING_DISCLOSURE_VERSION, granted_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await grantScreeningConsent({
      workerId: check.user_id,
      provider: 'checkr',
      purpose: 'Eligibility for task categories that explicitly require screening.',
      disclosureVersion: WORKER_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: WORKER_SCREENING_DISCLOSURE_HASH,
      disclosurePresentedStandalone: true,
      consentGranted: true,
      purposeAcknowledged: true,
      rightsSummaryAcknowledged: true,
      providerNamed: true,
      idempotencyKey: 'consent-key-1',
    });
    expect(result.consentId).toBe('consent-1');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('worker_screening_consents');
    expect(mocks.query.mock.calls[2]?.[0]).toContain("'CONSENT_GRANTED'");
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('rejects an idempotency replay whose consent payload changed', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: 'consent-1', request_hash: 'b'.repeat(64),
      disclosure_version: WORKER_SCREENING_DISCLOSURE_VERSION, granted_at: 'now',
    }] });
    await expect(grantScreeningConsent({
      workerId: check.user_id, provider: 'checkr', purpose: 'Eligibility for screened task categories.',
      disclosureVersion: WORKER_SCREENING_DISCLOSURE_VERSION, disclosureHash: WORKER_SCREENING_DISCLOSURE_HASH,
      disclosurePresentedStandalone: true, consentGranted: true, purposeAcknowledged: true,
      rightsSummaryAcknowledged: true, providerNamed: true, idempotencyKey: 'consent-key-1',
    })).rejects.toThrow('already used for different terms');
  });

  it('shows report access, provider contact, dispute, appeal, and neutral rank rights', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...check, status: 'FAILED' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'consent-1', provider: 'checkr', disclosure_version: WORKER_SCREENING_DISCLOSURE_VERSION,
        granted_at: '2026-07-17T00:00:00.000Z', revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        delivered_at: '2026-07-18T02:00:00.000Z', final_action_eligible_at: '2026-07-01T00:00:00.000Z',
        report_access_path: '/screening/report/1', provider_name: 'Checkr', provider_address: 'Address',
        provider_phone: '555-0100', dispute_instructions: 'Dispute inaccurate information.',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'appeal-1', status: 'OPEN', reason: 'Human review', opened_at: 'now' }] });
    const result = await getMyScreeningRights(check.user_id);
    expect(result.rights).toMatchObject({
      canInspectReport: true, canDispute: true, canAppeal: true,
      openCategoryEligibility: 'UNCHANGED', rankingAdjustment: 0,
    });
    expect(result.report?.provider).toEqual({ name: 'Checkr', address: 'Address', phone: '555-0100' });
  });

  it('opens a worker-owned dispute and pauses the check in one transaction', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [check] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'dispute-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(submitScreeningDispute({
      workerId: check.user_id, checkId: check.id,
      reason: 'The report includes a record that does not belong to me.', idempotencyKey: 'dispute-key-1',
    })).resolves.toEqual({ disputeId: 'dispute-1', status: 'OPEN' });
    expect(mocks.query.mock.calls[3]?.[0]).toContain("status = 'DISPUTED'");
    expect(mocks.query.mock.calls[4]?.[0]).toContain("'DISPUTE_OPENED'");
  });

  it('delivers report and rights before entering the pre-adverse review window', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [check] })
      .mockResolvedValueOnce({ rows: [{ final_action_eligible_at: '2026-07-25T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await beginPreAdverseAction({
      adminId: '33333333-3333-4333-8333-333333333333', checkId: check.id,
      reasonCodes: ['CATEGORY_SAFETY_POLICY'], providerName: 'Checkr', providerAddress: 'Address',
      providerPhone: '555-0100', reportAccessPath: '/screening/report/1',
      disputeInstructions: 'Open a dispute from this page before the review window closes.',
      rightsSummaryVersion: 'fcra-summary-current', idempotencyKey: 'pre-adverse-key-1',
    });
    expect(result).toEqual({ status: 'PRE_ADVERSE', finalActionEligibleAt: '2026-07-25T00:00:00.000Z' });
    expect(mocks.query.mock.calls[1]?.[0]).toContain("'PRE_ADVERSE'");
    expect(mocks.query.mock.calls[2]?.[0]).toContain("status = 'PRE_ADVERSE'");
  });

  it('routes final action through the database gate and emits the required final notice', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...check, status: 'PRE_ADVERSE' }] })
      .mockResolvedValueOnce({ rows: [{
        reason_codes: ['CATEGORY_SAFETY_POLICY'], provider_name: 'Checkr', provider_address: 'Address',
        provider_phone: '555-0100', provider_decision_disclaimer: 'Provider did not decide.',
        report_access_path: '/screening/report/1', rights_summary_version: 'fcra-summary-current',
        dispute_instructions: 'Dispute inaccurate information.',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(finalizeAdverseAction({
      adminId: '33333333-3333-4333-8333-333333333333', checkId: check.id,
      idempotencyKey: 'adverse-key-1',
    })).resolves.toEqual({ status: 'FAILED' });
    expect(mocks.query.mock.calls[2]?.[0]).toContain("status = 'FAILED'");
    expect(mocks.query.mock.calls[3]?.[0]).toContain("'FINAL_ADVERSE'");
    expect(mocks.query.mock.calls[3]?.[0]).toContain("INTERVAL '60 days'");
  });

  it('allows an appeal only after a final decision', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...check, status: 'FAILED' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'appeal-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(submitScreeningAppeal({
      workerId: check.user_id, checkId: check.id,
      reason: 'The final decision did not account for the corrected record.', idempotencyKey: 'appeal-key-1',
    })).resolves.toEqual({ appealId: 'appeal-1', status: 'OPEN' });
  });
});
