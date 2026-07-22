export const WORKER_SCREENING_DISCLOSURE_VERSION = 'hx-worker-screening-rights-v1';
export const WORKER_SCREENING_POLICY_VERSION = 'hx-worker-screening-policy-v1';
export const WORKER_SCREENING_DISCLOSURE_COPY = 'HustleXP may obtain a background screening report from the named provider only to determine eligibility for task categories that explicitly require enhanced screening. You may inspect and dispute report information, receive notices before and after adverse action, appeal a final HustleXP decision, withdraw permission for future orders, and keep unchanged ranking and access to categories that do not require screening.';
export const WORKER_SCREENING_DISCLOSURE_HASH = '61d054648dabd5b3533337363e87f2a8c628c60878aff6c25f4d2a1fbf88df4f';
export const LOCAL_CERTIFICATION_SCREENING_PROVIDER = 'local_certification_test' as const;
export const LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION = 'hx-worker-screening-local-test-v1';
export const LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_COPY = "Local certification TEST screening does not order or represent a criminal-history or consumer report. It exercises only HustleXP's consent, eligibility, audit, and recovery controls in a non-production environment. It can unlock CONTROLLED_TEST work only, never production work.";
export const LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH = 'c059a2d7b341b9f951a97f9e28a93afe3f763015a0c7ffd8bd9f7f15ab2e8565';
export const LOCAL_CERTIFICATION_SCREENING_PURPOSE = 'Exercise consent-bound eligibility controls for CONTROLLED_TEST work only; no external background or consumer report is ordered.';
export const PRE_ADVERSE_REVIEW_HOURS = 168;

export type ScreeningProvider =
  | 'checkr'
  | 'sterling'
  | 'goodhire'
  | 'manual'
  | typeof LOCAL_CERTIFICATION_SCREENING_PROVIDER;

export function screeningDisclosureForProvider(provider?: ScreeningProvider): {
  version: string;
  hash: string;
  copy: string;
  isTest: boolean;
} {
  if (provider === LOCAL_CERTIFICATION_SCREENING_PROVIDER) {
    return {
      version: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
      hash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
      copy: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_COPY,
      isTest: true,
    };
  }
  return {
    version: WORKER_SCREENING_DISCLOSURE_VERSION,
    hash: WORKER_SCREENING_DISCLOSURE_HASH,
    copy: WORKER_SCREENING_DISCLOSURE_COPY,
    isTest: false,
  };
}

export type WorkerScreeningStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'CLEAR'
  | 'CONSIDER'
  | 'PRE_ADVERSE'
  | 'DISPUTED'
  | 'FAILED'
  | 'EXPIRED';

export interface ScreeningConsentInput {
  provider?: ScreeningProvider;
  disclosureVersion: string;
  disclosureHash: string;
  disclosurePresentedStandalone: boolean;
  consentGranted: boolean;
  purposeAcknowledged: boolean;
  rightsSummaryAcknowledged: boolean;
  providerNamed: boolean;
}

export interface ScreeningRightsProjection {
  policyVersion: string;
  disclosureVersion: string;
  status: WorkerScreeningStatus;
  canInspectReport: boolean;
  canDispute: boolean;
  canAppeal: boolean;
  canRevokeFutureChecks: boolean;
  restrictedCategoryEligibility: 'ELIGIBLE' | 'LOCKED';
  openCategoryEligibility: 'UNCHANGED';
  rankingAdjustment: 0;
  paidPromotionAffectsDecision: false;
  finalAdverseActionAllowed: boolean;
  blockers: string[];
}

export function validateScreeningConsent(input: ScreeningConsentInput): string[] {
  const blockers: string[] = [];
  const disclosure = screeningDisclosureForProvider(input.provider);
  if (input.disclosureVersion !== disclosure.version) blockers.push('STALE_DISCLOSURE');
  if (input.disclosureHash !== disclosure.hash) blockers.push('DISCLOSURE_CONTENT_MISMATCH');
  if (!input.disclosurePresentedStandalone) blockers.push('DISCLOSURE_NOT_STANDALONE');
  if (!input.consentGranted) blockers.push('WRITTEN_CONSENT_REQUIRED');
  if (!input.purposeAcknowledged) blockers.push('PURPOSE_NOT_ACKNOWLEDGED');
  if (!input.rightsSummaryAcknowledged) blockers.push('RIGHTS_NOT_ACKNOWLEDGED');
  if (!input.providerNamed) blockers.push('SCREENING_PROVIDER_NOT_NAMED');
  return blockers;
}

export function projectScreeningRights(input: {
  status: WorkerScreeningStatus;
  reportAvailable: boolean;
  preAdverseNoticeDelivered: boolean;
  reviewWindowElapsed: boolean;
  openDispute: boolean;
}): ScreeningRightsProjection {
  const canDispute = ['CONSIDER', 'PRE_ADVERSE', 'DISPUTED', 'FAILED'].includes(input.status);
  const blockers: string[] = [];
  if (!input.preAdverseNoticeDelivered) blockers.push('PRE_ADVERSE_NOTICE_REQUIRED');
  if (!input.reportAvailable) blockers.push('REPORT_ACCESS_REQUIRED');
  if (!input.reviewWindowElapsed) blockers.push('REVIEW_WINDOW_OPEN');
  if (input.openDispute) blockers.push('DISPUTE_UNRESOLVED');

  return {
    policyVersion: WORKER_SCREENING_POLICY_VERSION,
    disclosureVersion: WORKER_SCREENING_DISCLOSURE_VERSION,
    status: input.status,
    canInspectReport: input.reportAvailable,
    canDispute,
    canAppeal: input.status === 'FAILED',
    canRevokeFutureChecks: true,
    restrictedCategoryEligibility: input.status === 'CLEAR' ? 'ELIGIBLE' : 'LOCKED',
    openCategoryEligibility: 'UNCHANGED',
    rankingAdjustment: 0,
    paidPromotionAffectsDecision: false,
    finalAdverseActionAllowed: blockers.length === 0,
    blockers,
  };
}
