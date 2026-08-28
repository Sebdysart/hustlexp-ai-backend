import { getClient } from '../cache/redis.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'ProofService' });
const REVIEW_LOCK_TTL_SECONDS = 300;

function reviewLockKey(proofId: string): string {
  return `proof:reviewing:${proofId}`;
}

export async function acquireProofReviewLock(proofId: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    log.warn({ proofId }, 'Redis unavailable — skipping advisory review lock (Phase 3 transaction remains authoritative)');
    return true;
  }
  try {
    const result = await client.set(reviewLockKey(proofId), '1', {
      ex: REVIEW_LOCK_TTL_SECONDS,
      nx: true,
    });
    return result === 'OK';
  } catch (error) {
    log.warn({ proofId, err: error }, 'Redis error acquiring review lock — failing open');
    return true;
  }
}

export async function releaseProofReviewLock(proofId: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.del(reviewLockKey(proofId));
  } catch (error) {
    log.warn({ proofId, err: error }, 'Redis error releasing review lock — lock will expire via TTL');
  }
}
