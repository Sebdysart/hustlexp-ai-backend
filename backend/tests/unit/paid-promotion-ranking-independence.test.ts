import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const canonicalRankingPaths = [
  'backend/src/services/TaskDiscoveryQueryBuilder.ts',
  'backend/src/services/TaskDiscoveryScoring.ts',
  'backend/src/services/TaskDiscoveryScoreService.ts',
  'backend/src/services/TaskEligibilityPolicy.ts',
  'backend/src/services/TaskDiscoveryOfferService.ts',
];

describe('paid promotion cannot enter canonical task matching', () => {
  it.each(canonicalRankingPaths)('%s has no featured-listing or paid-boost input', (path) => {
    const contents = source(path);
    expect(contents).not.toMatch(/featured_listings/i);
    expect(contents).not.toMatch(/promotion_boost/i);
    expect(contents).not.toMatch(/urgent_boost/i);
  });

  it('fails closed if a promotion input reaches the offer boundary', () => {
    const policy = source('backend/src/services/WorkerOfferDecisionPolicy.ts');
    expect(policy).toContain('paid_promotion_rank_input_prohibited');
    expect(policy).toContain('paidPromotionAffectsRank: false');
  });
});
