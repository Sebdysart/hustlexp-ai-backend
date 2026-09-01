import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  onboardProviderOsClient: vi.fn(),
  createProviderOsInvite: vi.fn(),
  previewProviderOsInvite: vi.fn(),
  acceptProviderOsInvite: vi.fn(),
  listProviderOsClients: vi.fn(),
  listProviderOsDrafts: vi.fn(),
  getProviderOsDraft: vi.fn(),
}));

vi.mock('../../src/services/ProviderOsService.js', () => service);
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { providerOsRouter } from '../../src/routers/providerOs.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const POSTER = '10000000-0000-4000-8000-000000000001';
const DRAFT = '20000000-0000-4000-8000-000000000001';
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

  it('binds onboarding to the authenticated provider, not a client-supplied actor', async () => {
    service.onboardProviderOsClient.mockResolvedValue({
      success: true,
      data: {
        relationshipId: '30000000-0000-4000-8000-000000000001',
        posterUserId: POSTER,
        fullName: 'Poster A',
        email: 'poster@example.com',
        onboardedAt: '2026-08-31T00:00:00.000Z',
        openDraftCount: 0,
      },
    });
    await caller.onboardClient({ posterEmail: 'poster@example.com' });
    expect(service.onboardProviderOsClient).toHaveBeenCalledWith({
      actorId: ACTOR,
      posterEmail: 'poster@example.com',
    });
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
    await caller.createInvite({ intendedEmail: 'new@example.com' });
    expect(service.createProviderOsInvite).toHaveBeenCalledWith({
      actorId: ACTOR,
      intendedEmail: 'new@example.com',
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

  it('lists drafts through the relationship, optionally filtered by poster', async () => {
    service.listProviderOsDrafts.mockResolvedValue({ success: true, data: [] });
    await caller.listDrafts({ posterUserId: POSTER });
    expect(service.listProviderOsDrafts).toHaveBeenCalledWith({
      actorId: ACTOR,
      posterUserId: POSTER,
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
    await caller.getDraft({ draftId: DRAFT });
    expect(service.getProviderOsDraft).toHaveBeenCalledWith({
      actorId: ACTOR,
      draftId: DRAFT,
    });
  });
});
