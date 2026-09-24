import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn(), access: vi.fn(), analytics: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: {
  query: mocks.query,
  transaction: (work: (query: typeof mocks.query) => unknown) => work(mocks.query),
} }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: { createInTransaction: mocks.notify } }));
vi.mock('../../src/services/ProviderOsAccess.js', () => ({ assertProviderOsAccess: mocks.access }));
vi.mock('../../src/services/AnalyticsService.js', () => ({ AnalyticsService: { track: mocks.analytics } }));
vi.mock('../../src/services/BusinessAssessmentService.js', () => ({ requestBusinessProposalAssessment: vi.fn() }));
// Only bypass unrelated session middleware. The real route input validator,
// transaction, acquisition checks, shared quote writer and eligibility engine run.
vi.mock('../../src/trpc.js', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<{ user: { id: string } }>().create();
  return { router: t.router, protectedProcedure: t.procedure };
});

import { claimBusinessTask, createBusinessQuoteInTransaction, quoteAfterAssessment } from '../../src/services/BusinessClaimService.js';
import { activatePendingBusinessQuotesInTransaction } from '../../src/services/BusinessQuoteActivationService.js';
import { setProviderOsDraftQuote } from '../../src/services/ProviderOsService.js';
import { businessProposalRouter } from '../../src/routers/businessProposal.js';

const ids = {
  org: '10000000-0000-4000-8000-000000000001', actor: '10000000-0000-4000-8000-000000000002',
  draft: '10000000-0000-4000-8000-000000000003', proposal: '10000000-0000-4000-8000-000000000004',
  quote: '10000000-0000-4000-8000-000000000005', version: '10000000-0000-4000-8000-000000000006',
};
const origins = ['claim_link', 'direct_proposal', 'provider_os'] as const;
type Origin = typeof origins[number];
const amounts = { proposedCustomerTotalCents: 12000, proposedPayoutCents: 10000,
  arrivalWindowStart: '2026-11-01T12:00:00Z', arrivalWindowEnd: '2026-11-02T18:00:00Z' };
const shared = { ...amounts, organizationId: ids.org, actorId: ids.actor };
const draft = { id: ids.draft, category: 'cleaning', title: 'Clean kitchen', scope_summary: 'Clean kitchen surfaces',
  region_code: 'US-WA', poster_user_id: 'poster', status: 'draft', quote_id: null, task_id: null, claimed_at: null };

interface Scenario {
  selected?: boolean; origin?: Origin; ownerless?: boolean; pendingVerification?: boolean;
  pendingActivation?: boolean; existingDecision?: boolean; existingQuote?: boolean;
  proposalReplay?: boolean; assessmentReplay?: boolean; credentialRequired?: boolean;
  credentialExpired?: boolean; snapshotConflict?: boolean;
}

/** SQL-dispatched relational fixture, not a mocked eligibility decision. Unknown
 * statements fail so new authority reads cannot accidentally receive success. */
function installScenario(s: Scenario = {}) {
  mocks.query.mockImplementation(async (raw: string) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
    if (sql.startsWith('SELECT business_require_action')) return rows([]);
    if (sql.includes('FROM business_organizations') && sql.startsWith('SELECT')) return rows([{ id: ids.org,
      status: 'ACTIVE', provider_enabled: true, verification_status: s.pendingVerification ? 'PENDING' : 'VERIFIED',
      legal_name: 'Test Business', display_name: 'Test Business', washington_ubi: '123456789', federal_ein: '123456789' }]);
    if (sql.includes('FROM task_drafts') && sql.startsWith('SELECT')) return rows([{ ...draft, poster_user_id: s.ownerless ? null : draft.poster_user_id }]);
    if (sql.includes('FROM service_categories')) return rows([{ id: 'category', code: 'cleaning', display_name: 'Cleaning', status: 'ACTIVE' }]);
    if (sql.includes('FROM business_service_profiles')) return rows([{ id: 'canonical-profile', service_code: 'cleaning', service_category_id: 'category',
      selected_by_business: s.selected !== false, eligibility_status: 'DECLARED', eligibility_reviewed_policy_id: null,
      eligibility_reviewed_at: null, eligibility_reviewed_by: null }]);
    if (sql.includes('FROM service_credential_requirements')) return rows(s.credentialRequired ? [{ id: 'requirement',
      service_category_policy_id: 'policy', credential_type_id: 'license-type', required: true, code: 'TEST_LICENSE',
      display_name: 'Test license', status: 'ACTIVE', jurisdiction_code: 'US-WA', requires_number: true,
      requires_evidence: true, supports_expiration: true }] : []);
    if (sql.includes('FROM service_category_policies')) return rows([{ id: 'policy', service_category_id: 'category',
      jurisdiction_code: 'US-WA', policy_status: s.credentialRequired ? 'CREDENTIAL_REQUIRED' : 'UNRESTRICTED',
      policy_version: 3, effective_from: '2026-01-01T00:00:00Z', effective_to: null, manual_review_required: false }]);
    if (sql.includes('FROM business_credentials c')) return rows(s.credentialRequired ? [{ id: 'credential', credential_type_id: 'license-type',
      membership_id: null, status: 'ACTIVE', current_version_id: 'credential-version',
      expires_at: s.credentialExpired ? '2026-09-01T00:00:00Z' : '2027-01-01T00:00:00Z',
      verified_at: '2026-09-01T00:00:00Z', verified_by: 'ops', issued_at: '2026-01-01T00:00:00Z',
      jurisdiction_code: 'US-WA', credential_number: 'license-number', evidence_count: 1,
      version_snapshot: { credentialNumber: 'license-number', uploadReceiptIds: ['private-receipt'] } }] : []);
    if (sql.startsWith('SELECT id FROM business_quote_eligibility_decisions')) return rows(s.existingDecision ? [{ id: 'decision' }] : []);
    if (sql.startsWith('INSERT INTO business_quote_eligibility_decisions')) {
      if (s.snapshotConflict) throw Object.assign(new Error('duplicate quote decision'), { code: '23505' });
      return rows([{ id: 'decision' }]);
    }
    if (sql.startsWith('SELECT id, task_draft_id FROM quotes')) return rows(s.pendingActivation ? [{ id: ids.quote, task_draft_id: ids.draft }] : []);
    if (sql.startsWith('SELECT id FROM quotes')) return rows(s.existingQuote ? [{ id: ids.quote }] : []);
    if (sql.startsWith('SELECT qv.id,')) return rows([{ id: ids.version, eligible: true }]);
    if (sql.startsWith('SELECT q.id,v.id AS version_id')) return rows([{ id: ids.quote, version_id: ids.version,
      total_cents: 12000, payout_cents: 10000, expires_at: new Date('2026-11-01T00:00:00Z') }]);
    if (sql.startsWith('INSERT INTO quotes')) return rows([{ id: ids.quote }]);
    if (sql.startsWith('INSERT INTO quote_versions')) return rows([{ id: ids.version }]);
    if (sql.startsWith('UPDATE quotes q SET status')) return rows([{ id: ids.quote }]);
    if (sql.startsWith('UPDATE quotes SET')) return rows([]);
    if (sql.includes('FROM ops_business_claim_links')) return rows([{ id: 'claim', task_draft_id: ids.draft,
      status: sql.includes('token_hash') ? 'OPEN' : 'CLAIMED', expires_at: new Date('2026-11-01T00:00:00Z'),
      claimed_by_organization_id: ids.org, quote_id: null }]);
    if (sql.includes('FROM business_task_proposals')) return rows([{ id: ids.proposal, task_draft_id: ids.draft,
      business_organization_id: ids.org, status: s.proposalReplay ? 'QUOTED' : 'PENDING',
      expires_at: new Date('2026-11-01T00:00:00Z'), quote_id: s.proposalReplay ? ids.quote : null }]);
    if (sql.includes('FROM business_assessment_requests')) return rows(sql.includes('WHERE id = $1 FOR UPDATE') ? [{
      id: 'assessment', task_draft_id: ids.draft, business_organization_id: ids.org, status: 'COMPLETED', assessment_fee_cents: 0,
      quote_id: s.assessmentReplay ? ids.quote : null, claim_link_id: s.origin === 'claim_link' ? 'claim' : null,
      proposal_id: s.origin === 'direct_proposal' ? ids.proposal : null, provider_os_relationship_id: s.origin === 'provider_os' ? 'relationship' : null,
    }] : []);
    if (sql.includes('FROM assessment_payments')) return rows([]);
    if (sql.includes('FROM provider_os_relationships')) return rows([{ id: 'relationship' }]);
    if (/^(UPDATE ops_business_claim_links|UPDATE business_task_proposals|UPDATE business_assessment_requests|INSERT INTO business_audit_events)/.test(sql)) return rows([{ id: 'updated' }]);
    throw new Error(`Unconfigured quote test SQL: ${sql}`);
  });
}

function statements(fragment: string) { return mocks.query.mock.calls.filter(([sql]) => sql.includes(fragment)); }
function input(origin: Origin) { return { ...shared, draft, acquisitionOrigin: origin,
  quoteExpiresAt: new Date('2026-11-01T00:00:00Z'), serviceProfileId: 'untrusted-client-profile', businessLocationId: 'untrusted-location' }; }
function expectNoQuoteWrites() {
  expect(statements('INSERT INTO quotes')).toHaveLength(0);
  expect(statements('INSERT INTO quote_versions')).toHaveLength(0);
  expect(statements('INSERT INTO business_quote_eligibility_decisions')).toHaveLength(0);
  expect(mocks.notify).not.toHaveBeenCalled();
}
function expectSnapshotBeforePublish(origin: Origin) {
  const quote = statements('INSERT INTO quotes')[0];
  expect(quote[1][5]).toBe(origin);
  expect(quote[1][6]).toBe('canonical-profile');
  const snapshot = statements('INSERT INTO business_quote_eligibility_decisions');
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0][1].slice(0, 9)).toEqual([ids.quote, ids.version, ids.draft, ids.org,
    'canonical-profile', 'cleaning', 'US-WA', 'policy', 3]);
  const calls = mocks.query.mock.calls;
  expect(calls.indexOf(snapshot[0])).toBeLessThan(calls.findIndex(([sql]) => sql.includes("UPDATE quotes q SET status = 'submitted'")));
  expect(mocks.notify).toHaveBeenCalledWith(mocks.query, expect.objectContaining({ entityId: ids.quote, userId: 'poster' }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  mocks.access.mockResolvedValue(undefined);
  mocks.notify.mockResolvedValue(undefined);
  mocks.analytics.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('shared canonical business quote gate', () => {
  it.each(origins)('persists server eligibility and publishes %s in the same transaction', async origin => {
    installScenario();
    expect(await createBusinessQuoteInTransaction(mocks.query, input(origin))).toMatchObject({ success: true });
    expectSnapshotBeforePublish(origin);
    expect(statements('SELECT category,region_code')[0][1]).toEqual([ids.draft]);
    expect(statements('FROM business_service_profiles')[0][1]).toEqual([ids.org]);
  });
  it.each(origins)('denies %s before any quote writes when service is not selected', async origin => {
    installScenario({ selected: false });
    expect(await createBusinessQuoteInTransaction(mocks.query, input(origin))).toMatchObject({ success: false, error: { code: 'BUSINESS_SERVICE_NOT_OFFERED' } });
    expectNoQuoteWrites();
  });
  it('freezes the verified credential version and source evidence, not a client claim', async () => {
    installScenario({ credentialRequired: true });
    await createBusinessQuoteInTransaction(mocks.query, input('direct_proposal'));
    expect(JSON.parse(statements('INSERT INTO business_quote_eligibility_decisions')[0][1][11])).toEqual([
      expect.objectContaining({ credentialId: 'credential', credentialVersionId: 'credential-version', status: 'ACTIVE',
        expiresAt: '2027-01-01T00:00:00.000Z', verifiedBy: 'ops', credentialEvidence: { credentialNumber: 'license-number', uploadReceiptIds: ['private-receipt'] } }),
    ]);
  });
  it('fails closed on decision uniqueness conflict before publication', async () => {
    installScenario({ snapshotConflict: true });
    await expect(createBusinessQuoteInTransaction(mocks.query, input('claim_link'))).rejects.toMatchObject({ code: '23505' });
    expect(statements("UPDATE quotes q SET status = 'submitted'")).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('does not replace an existing quote decision on a duplicate submission', async () => {
    installScenario({ existingQuote: true, selected: false });
    expect(await createBusinessQuoteInTransaction(mocks.query, input('claim_link'))).toMatchObject({ success: false, error: { code: 'BUSINESS_ALREADY_QUOTED' } });
    expect(statements('FROM service_categories')).toHaveLength(0);
    expectNoQuoteWrites();
  });
  it('persists the decision for pending organization verification without premature publication', async () => {
    installScenario({ pendingVerification: true });
    expect(await claimBusinessTask({ ...shared, token: 'claim-token' })).toMatchObject({ success: true, data: { quoteStatus: 'pending_business_verification' } });
    expect(statements('INSERT INTO business_quote_eligibility_decisions')).toHaveLength(1);
    expect(statements("UPDATE quotes q SET status = 'submitted'")).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('acquisition adapters call the real shared engine', () => {
  async function submit(origin: Origin) {
    if (origin === 'claim_link') return claimBusinessTask({ ...shared, token: 'claim-token' });
    if (origin === 'provider_os') return setProviderOsDraftQuote({ ...shared, draftId: ids.draft });
    return businessProposalRouter.createCaller({ user: { id: ids.actor } } as never).quote({ proposalId: ids.proposal, ...amounts });
  }
  it.each(origins)('%s adapter succeeds with server-approved service', async origin => {
    installScenario({ origin });
    const result = await submit(origin);
    expect(result).toMatchObject(origin === 'direct_proposal' ? { ok: true, quote_id: ids.quote } : { success: true });
    expectSnapshotBeforePublish(origin);
  });
  it.each(origins)('%s adapter cannot bypass the service gate', async origin => {
    installScenario({ origin, selected: false });
    if (origin === 'direct_proposal') {
      await expect(submit(origin)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { applicationCode: 'BUSINESS_SERVICE_NOT_OFFERED' } });
    } else expect(await submit(origin)).toMatchObject({ success: false, error: { code: 'BUSINESS_SERVICE_NOT_OFFERED' } });
    expectNoQuoteWrites();
  });
  it.each(['claim_link', 'direct_proposal'] as const)('preserves eligible ownerless %s quoting without fake notifications', async origin => {
    installScenario({ ownerless: true, origin });
    expect(await submit(origin)).toMatchObject(origin === 'direct_proposal' ? { ok: true } : { success: true });
    expect(statements('INSERT INTO business_quote_eligibility_decisions')).toHaveLength(1);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('keeps Provider OS ownerless drafts unavailable', async () => {
    installScenario({ ownerless: true });
    expect(await submit('provider_os')).toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expectNoQuoteWrites();
  });
  it('returns an existing proposal quote without reevaluating ordinary credential expiry', async () => {
    installScenario({ proposalReplay: true, credentialRequired: true, credentialExpired: true });
    expect(await submit('direct_proposal')).toMatchObject({ ok: true, quote_id: ids.quote, replayed: true });
    expect(statements('FROM business_credentials c')).toHaveLength(0);
    expectNoQuoteWrites();
  });
});

describe('post-assessment quotes converge without changing assessment state rules', () => {
  it.each(origins)('evaluates and snapshots %s after completed assessment', async origin => {
    installScenario({ origin });
    expect(await quoteAfterAssessment({ ...shared, assessmentRequestId: 'assessment' })).toMatchObject({ success: true });
    expectSnapshotBeforePublish(origin);
  });
  it.each(origins)('denies expired credentials for a new %s assessment quote', async origin => {
    installScenario({ origin, credentialRequired: true, credentialExpired: true });
    expect(await quoteAfterAssessment({ ...shared, assessmentRequestId: 'assessment' })).toMatchObject({ success: false, error: { code: 'BUSINESS_CREDENTIAL_EXPIRED' } });
    expectNoQuoteWrites();
    expect(statements('UPDATE business_assessment_requests')).toHaveLength(0);
  });
  it('replays an existing assessment quote without changing its historical decision', async () => {
    installScenario({ assessmentReplay: true, credentialRequired: true, credentialExpired: true });
    expect(await quoteAfterAssessment({ ...shared, assessmentRequestId: 'assessment' })).toMatchObject({ success: true, data: { quoteId: ids.quote, replayed: true } });
    expect(statements('FROM business_credentials c')).toHaveLength(0);
    expectNoQuoteWrites();
  });
});

describe('pending verification publication', () => {
  it('uses the historical decision without reevaluating later credential expiration', async () => {
    installScenario({ pendingActivation: true, existingDecision: true, credentialRequired: true, credentialExpired: true });
    expect(await activatePendingBusinessQuotesInTransaction(mocks.query, ids.org)).toBe(1);
    expect(statements('FROM business_credentials c')).toHaveLength(0);
    expect(statements('INSERT INTO business_quote_eligibility_decisions')).toHaveLength(0);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
  it('requires and persists an initial decision before publishing a legacy pending quote', async () => {
    installScenario({ pendingActivation: true });
    expect(await activatePendingBusinessQuotesInTransaction(mocks.query, ids.org)).toBe(1);
    const calls = mocks.query.mock.calls;
    expect(calls.findIndex(([sql]) => sql.includes('INSERT INTO business_quote_eligibility_decisions')))
      .toBeLessThan(calls.findIndex(([sql]) => sql.includes("UPDATE quotes q SET status = 'submitted'")));
    expect(statements('UPDATE quotes SET provider_service_profile_id')[0][1]).toEqual([ids.quote, 'canonical-profile']);
  });
  it('does not publish a legacy pending quote with expired credentials', async () => {
    installScenario({ pendingActivation: true, credentialRequired: true, credentialExpired: true });
    expect(await activatePendingBusinessQuotesInTransaction(mocks.query, ids.org)).toBe(0);
    expect(statements("UPDATE quotes q SET status = 'submitted'")).toHaveLength(0);
    expectNoQuoteWrites();
  });
});
