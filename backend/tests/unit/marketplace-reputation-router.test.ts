import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/MarketplaceReputationService', () => ({
  MarketplaceReputationService: {
    getPublicSummary: vi.fn(), submitLocalRecommendation: vi.fn(), appealSignal: vi.fn(),
    verifyRegionMembership: vi.fn(), moderateRecommendation: vi.fn(), resolveAppeal: vi.fn(),
  },
}));
vi.mock('../../src/services/ReputationAIService', () => ({ ReputationAIService: {} }));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { reputationRouter } from '../../src/routers/reputation';
import { MarketplaceReputationService } from '../../src/services/MarketplaceReputationService';

const PROVIDER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SIGNAL_ID = '33333333-3333-4333-8333-333333333333';
const reputation = vi.mocked(MarketplaceReputationService);

const publicCaller = reputationRouter.createCaller({ user: null });
const userCaller = reputationRouter.createCaller({
  user: { id: USER_ID, email: 'neighbor@example.com', full_name: 'Neighbor', account_status: 'ACTIVE' } as any,
  firebaseUid: 'firebase-neighbor',
});

describe('marketplace reputation router contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes a privacy-safe category summary publicly', async () => {
    reputation.getPublicSummary.mockResolvedValue({ success: true, data: { providerUserId: PROVIDER_ID } } as any);
    await publicCaller.getProviderSummary({ providerUserId: PROVIDER_ID, category: 'yard_help', regionCode: 'US-WA' });
    expect(reputation.getPublicSummary).toHaveBeenCalledWith(PROVIDER_ID, 'yard_help', 'US-WA');
  });

  it('binds a local recommendation to the authenticated recommender', async () => {
    reputation.submitLocalRecommendation.mockResolvedValue({ success: true, data: { id: 'rec-1' } } as any);
    await userCaller.submitLocalRecommendation({
      providerUserId: PROVIDER_ID, category: 'yard_help', regionCode: 'US-WA',
      body: 'Reliable help with seasonal yard cleanup.', relationship: 'NEIGHBOR',
      idempotencyKey: 'local-rec-0001',
    });
    expect(reputation.submitLocalRecommendation).toHaveBeenCalledWith(expect.objectContaining({
      recommenderId: USER_ID, providerUserId: PROVIDER_ID,
    }));
  });

  it('binds a reputation appeal to the authenticated affected provider', async () => {
    reputation.appealSignal.mockResolvedValue({ success: true, data: { id: 'appeal-1' } } as any);
    await userCaller.appealSignal({
      signalId: SIGNAL_ID,
      reason: 'These accounts are unrelated and the recommendation is genuine.',
    });
    expect(reputation.appealSignal).toHaveBeenCalledWith({
      signalId: SIGNAL_ID, providerUserId: USER_ID,
      reason: 'These accounts are unrelated and the recommendation is genuine.',
    });
  });
});
