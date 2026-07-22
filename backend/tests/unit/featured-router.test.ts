import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

import { featuredRouter } from '../../src/routers/featured';

const POSTER_ID = '00000000-0000-4000-8000-000000000001';
const TASK_ID = '00000000-0000-4000-8000-000000000002';
const LISTING_ID = '00000000-0000-4000-8000-000000000003';

function caller() {
  return featuredRouter.createCaller({
    user: {
      id: POSTER_ID,
      email: 'poster@example.test',
      full_name: 'Poster',
      firebase_uid: 'poster-firebase',
      default_mode: 'poster',
    } as any,
    firebaseUid: 'poster-firebase',
  });
}

describe('Build-Now paid-promotion guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['promoted', 'highlighted', 'urgent_boost'] as const)(
    'rejects %s before creating a payment or database record',
    async (featureType) => {
      await expect(caller().promoteTask({ taskId: TASK_ID, featureType }))
        .rejects.toThrow('not available in the Build-Now release');
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it('rejects promotion confirmation before any database mutation', async () => {
    await expect(caller().confirmPromotion({
      listingId: LISTING_ID,
      stripePaymentIntentId: 'pi_build_now_disabled',
    })).rejects.toThrow('not available in the Build-Now release');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('exposes no paid-featured feed', async () => {
    await expect(caller().getFeaturedTasks()).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
