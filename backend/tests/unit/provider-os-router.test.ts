import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  createProviderOsInvite: vi.fn(),
  previewProviderOsInvite: vi.fn(),
  acceptProviderOsInvite: vi.fn(),
  setProviderOsDraftQuote: vi.fn(),
  listProviderOsClients: vi.fn(),
  listProviderOsDrafts: vi.fn(),
  getProviderOsDraft: vi.fn(),
}));

vi.mock('../../src/services/ProviderOsService.js', () => service);
vi.mock('../../src/db.js', () => { const query = vi.fn(); return { db: { query, transaction: vi.fn((fn) => fn(query)) } }; });
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { providerOsRouter } from '../../src/routers/providerOs.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const POSTER = '10000000-0000-4000-8000-000000000001';
const DRAFT = '20000000-0000-4000-8000-000000000001';
const ORG = '70000000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(64);

const caller = providerOsRouter.createCaller({
  user: {
    id: ACTOR,
    email: 'hustler@example.com',
    full_name: 'Hustler A',
    account_status: 'ACTIVE',
    default_mode: 'worker',
  } as never,
  firebaseUid: 'firebase-hustler',
});

describe('providerOs router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not expose email-only onboarding', () => {
    expect(providerOsRouter._def.procedures).not.toHaveProperty('onboardClient');
  });

  it('creates invite links for the authenticated provider', async () => {
    service.createProviderOsInvite.mockResolvedValue({
      success: true,
      data: {
        inviteId: '40000000-0000-4000-8000-000000000001',
        token: TOKEN,
        invitePath: `/provider-os/invite/${TOKEN}`,
        intendedEmail: 'new@example.com',
        expiresAt: '2026-10-01T00:00:00.000Z',
      },
    });
    await caller.createInvite({ organizationId: ORG, intendedEmail: 'new@example.com' });
    expect(service.createProviderOsInvite).toHaveBeenCalledWith({
      actorId: ACTOR,
      intendedEmail: 'new@example.com',
      organizationId: ORG,
    });
  });

  it('accepts invites as the authenticated customer, not a client-supplied actor', async () => {
    service.acceptProviderOsInvite.mockResolvedValue({
      success: true,
      data: {
        relationshipId: '30000000-0000-4000-8000-000000000001',
        posterUserId: ACTOR,
        fullName: 'Hustler A',
        email: 'hustler@example.com',
        onboardedAt: '2026-08-31T00:00:00.000Z',
        openDraftCount: 0,
      },
    });
    await caller.acceptInvite({ token: TOKEN });
    expect(service.acceptProviderOsInvite).toHaveBeenCalledWith({
      actorId: ACTOR,
      actorEmail: 'hustler@example.com',
      token: TOKEN,
    });
  });

  it('binds Provider OS setQuote to the authenticated provider and draft relationship path', async () => {
    service.setProviderOsDraftQuote.mockResolvedValue({
      success: true,
      data: {
        taskDraftId: DRAFT,
        quoteId: '50000000-0000-4000-8000-000000000001',
        quoteVersionId: '60000000-0000-4000-8000-000000000001',
        customerTotalCents: 12000,
        payoutCents: 10000,
        platformMarginCents: 2000,
        expiresAt: '2026-10-01T00:00:00.000Z',
      },
    });
    await caller.setQuote({
      draftId: DRAFT,
      organizationId: '70000000-0000-4000-8000-000000000001',
      proposedCustomerTotalCents: 12000,
      proposedPayoutCents: 10000,
      arrivalWindowStart: '2026-10-01T10:00:00.000Z',
      arrivalWindowEnd: '2026-10-01T12:00:00.000Z',
    });
    expect(service.setProviderOsDraftQuote).toHaveBeenCalledWith({
      actorId: ACTOR,
      draftId: DRAFT,
      organizationId: '70000000-0000-4000-8000-000000000001',
      proposedCustomerTotalCents: 12000,
      proposedPayoutCents: 10000,
      arrivalWindowStart: '2026-10-01T10:00:00.000Z',
      arrivalWindowEnd: '2026-10-01T12:00:00.000Z',
    });
  });

  it('lists drafts through the relationship, optionally filtered by poster', async () => {
    service.listProviderOsDrafts.mockResolvedValue({ success: true, data: [] });
    await caller.listDrafts({ organizationId: ORG, posterUserId: POSTER });
    expect(service.listProviderOsDrafts).toHaveBeenCalledWith({
      actorId: ACTOR,
      posterUserId: POSTER,
      organizationId: ORG,
    });
  });

  it('loads one draft only for the authenticated provider', async () => {
    service.getProviderOsDraft.mockResolvedValue({
      success: true,
      data: {
        id: DRAFT,
        posterUserId: POSTER,
        posterName: 'Poster A',
        title: 'Yard work',
        category: 'yard',
        status: 'contact_captured',
        scopeSummary: 'Mow the lawn',
        rawInput: 'Need the lawn mowed',
        zip: '98004',
        region: 'Bellevue',
        estPriceMinCents: 8900,
        estPriceMaxCents: 12000,
        createdAt: '2026-08-31T00:00:00.000Z',
        quoteId: null,
        quoteAction: { kind: 'EXISTING_QUOTE_FLOW', href: `/provider-os/drafts/${DRAFT}/quote` },
      },
    });
    await caller.getDraft({ draftId: DRAFT, organizationId: ORG });
    expect(service.getProviderOsDraft).toHaveBeenCalledWith({
      actorId: ACTOR,
      draftId: DRAFT,
      organizationId: ORG,
    });
  });
});

describe('Provider OS strict authority inputs', () => {
  it('requires explicit organization on workspace reads and invites', async () => {
    await expect(caller.listClients({} as never)).rejects.toThrow();
    await expect(caller.listDrafts({} as never)).rejects.toThrow();
    await expect(caller.getDraft({ draftId: DRAFT } as never)).rejects.toThrow();
    await expect(caller.createInvite({} as never)).rejects.toThrow();
  });
  it('does not allow invitation customers to choose an organization or actor', async () => {
    await expect(caller.acceptInvite({ token: TOKEN, organizationId: ORG } as never)).rejects.toThrow();
    await expect(caller.acceptInvite({ token: TOKEN, actorId: POSTER } as never)).rejects.toThrow();
  });
  it('rejects an ordinary worker attempting to grant entitlement', async () => {
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    await expect(caller.setEntitlement({ organizationId: ORG, status: 'active', reason: 'self grant' })).rejects.toThrow();
  });
});

it('allows operations capability to grant with an atomic before/after audit', async () => {
  const { db } = await import('../../src/db.js');
  vi.mocked(db.query).mockReset();
  vi.mocked(db.transaction).mockClear();
  vi.mocked(db.query).mockImplementation(async (sql) => {
    if (sql.includes('FROM admin_roles')) return { rows: [{ role: 'support', capability_granted: true }] } as never;
    if (sql.includes('FROM business_organizations')) return { rows: [{ status: 'ACTIVE', provider_enabled: true }] } as never;
    if (sql.includes('INSERT INTO provider_os_entitlements')) return { rows: [{ organization_id: ORG, status: 'active' }] } as never;
    return { rows: [] } as never;
  });
  const opsCaller = providerOsRouter.createCaller({ user: { id: ACTOR, account_status: 'ACTIVE', is_admin: true } as never, firebaseUid: 'ops' });
  const result = await opsCaller.setEntitlement({ organizationId: ORG, status: 'active', reason: 'Approved access' });
  expect(result.entitlement.status).toBe('active');
  expect(db.transaction).toHaveBeenCalledTimes(1);
  const audit = vi.mocked(db.query).mock.calls.find(([sql]) => sql.includes('INSERT INTO ops_action_audit'));
  expect(audit?.[1]?.slice(0, 2)).toEqual([ACTOR, ORG]);
  expect(JSON.parse(String(audit?.[1]?.[2]))).toEqual({ before: null, after: { organization_id: ORG, status: 'active' } });
});
