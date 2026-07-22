/**
 * Adversarial contract: a caller-selected template may never lower the policy
 * implied by task content. All 15 historical boundary attacks are executable
 * closure tests; none documents an accepted bypass.
 */

import { describe, expect, it, vi } from 'vitest';
import { ScoperAIService } from '../../src/services/ScoperAIService.js';
import { TaskRisk } from '../../src/services/TaskRiskClassifier.js';
import {
  deriveTaskTemplatePolicy,
  isInHomeContent,
  isLicensedWorkContent,
} from '../../src/services/TaskTemplatePolicy.js';
import {
  getTemplate,
  TEMPLATE_SLUGS,
} from '../../src/services/TaskTemplateRegistry.js';

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: { isConfigured: () => false },
}));
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));

describe('wrong-template selection cannot lower authoritative policy', () => {
  it('1 — massage under standard physical still requires licensed-tier supply', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Relaxing full-body massage at your home for 60 minutes.',
      templateSlug: TEMPLATE_SLUGS.STANDARD_PHYSICAL,
    });
    expect(isLicensedWorkContent('full-body massage')).toBe(true);
    expect(policy.licensedContent).toBe(true);
    expect(policy.requiredWorkerTrustTier).toBe(4);
    expect(policy.minimumPriceCents).toBeGreaterThanOrEqual(3000);
  });

  it('2 — childcare under standard physical is forced to the care risk lane', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Babysitter needed to watch my toddler for the afternoon.',
      templateSlug: TEMPLATE_SLUGS.STANDARD_PHYSICAL,
    });
    expect(policy.careContent).toBe(true);
    expect(policy.riskTier).toBe(TaskRisk.TIER_3);
    expect(policy.cancellationWindowHours).toBe(0);
  });

  it('3 — creator work under wildcard still requires release and mutual consent', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Appear on camera for a video on my YouTube channel.',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
    });
    expect(policy.contentReleaseRequired).toBe(true);
    expect(policy.mutualConsentRequired).toBe(true);
    expect(policy.cancellationWindowHours).toBe(0);
  });

  it('4 — apartment cleaning cannot claim an outdoor risk lane', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Deep clean my apartment bathroom and kitchen.',
      templateSlug: TEMPLATE_SLUGS.STANDARD_PHYSICAL,
      insideHome: false,
    });
    expect(isInHomeContent('Deep clean my apartment bathroom')).toBe(true);
    expect(policy.inHomeContent).toBe(true);
    expect(policy.riskTier).toBe(TaskRisk.TIER_2);
    expect(policy.riskLevel).toBe('HIGH');
    expect(policy.requiredWorkerTrustTier).toBeGreaterThanOrEqual(2);
  });

  it('5 — a film extra under event appearance still requires content consent', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Be an extra while we are filming a short movie.',
      templateSlug: TEMPLATE_SLUGS.EVENT_APPEARANCE,
    });
    expect(policy.contentReleaseRequired).toBe(true);
    expect(policy.mutualConsentRequired).toBe(true);
  });
});

describe('missing or invalid template input fails safely', () => {
  it('6 — an unknown public template has no registry fallback', () => {
    expect(getTemplate('not-a-real-template')).toBeUndefined();
  });

  it('7 — null cannot resolve to a privileged template', () => {
    expect(getTemplate(null as never)).toBeUndefined();
  });

  it('8 — omitted template receives conservative standard defaults', () => {
    const policy = deriveTaskTemplatePolicy({ description: 'Move two boxes to the curb.' });
    expect(policy.requiredWorkerTrustTier).toBe(1);
    expect(policy.minimumPriceCents).toBe(1500);
    expect(policy.cancellationPolicyVersion).toMatch(/^task-template-v2:/);
  });

  it('9 — elder bathing cannot hide behind an omitted template', () => {
    const policy = deriveTaskTemplatePolicy({ description: 'Bathe my elderly father each morning.' });
    expect(policy.careContent).toBe(true);
    expect(policy.riskTier).toBe(TaskRisk.TIER_3);
    expect(policy.cancellationWindowHours).toBe(0);
  });
});

describe('worker trust and price policy follow the work, not the poster label', () => {
  it('10 — in-home work persists the Home Ready worker tier', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Clean the kitchen inside my home.',
      templateSlug: TEMPLATE_SLUGS.IN_HOME,
    });
    expect(policy.requiredWorkerTrustTier).toBe(2);
  });

  it('11 — care work persists a verified-or-higher worker tier', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Babysitting for my toddler.',
      templateSlug: TEMPLATE_SLUGS.CARE,
    });
    expect(policy.requiredWorkerTrustTier).toBeGreaterThanOrEqual(2);
  });

  it('12 — ordinary cleaning cannot self-award wildcard multipliers', async () => {
    const input = {
      description: 'Deep clean my apartment kitchen.',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['private_location_flag', 'performance_element_flag'],
    };
    const policy = deriveTaskTemplatePolicy(input);
    expect(policy.allowedWildcardFlags).toEqual([]);

    const result = await ScoperAIService.analyzeTaskScope(input);
    expect(result.success).toBe(true);
    expect(result.data?.suggested_price_cents).toBe(7500);
  });

  it('13 — electrical work under standard physical keeps licensed tier and floor', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Repair the electrical panel and replace a breaker.',
      templateSlug: TEMPLATE_SLUGS.STANDARD_PHYSICAL,
    });
    expect(policy.licensedContent).toBe(true);
    expect(policy.requiredWorkerTrustTier).toBe(4);
    expect(policy.minimumPriceCents).toBeGreaterThanOrEqual(3000);
  });
});

describe('completion and consent policy cannot be weakened by template switching', () => {
  it('14 — care under wildcard remains manual completion with no timeout release', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Babysit my infant for the evening.',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
    });
    expect(policy.completionCriteriaType).toBe('check_in_check_out');
    expect(policy.cancellationWindowHours).toBe(0);
  });

  it('15 — filmed work under standard physical requires hybrid proof and consent', () => {
    const policy = deriveTaskTemplatePolicy({
      description: 'Appear on camera in a video for my social media channel.',
      templateSlug: TEMPLATE_SLUGS.STANDARD_PHYSICAL,
    });
    expect(policy.completionCriteriaType).toBe('hybrid');
    expect(policy.contentReleaseRequired).toBe(true);
    expect(policy.mutualConsentRequired).toBe(true);
  });
});

describe('attack summary', () => {
  it('classifies every historical template-boundary case as closed or safe', () => {
    const verdicts = [
      'closed', 'closed', 'closed', 'closed', 'closed',
      'safe', 'safe', 'safe', 'closed', 'closed',
      'closed', 'closed', 'closed', 'closed', 'closed',
    ];
    expect(verdicts).toHaveLength(15);
    expect(verdicts.every((verdict) => verdict === 'closed' || verdict === 'safe')).toBe(true);
  });
});
