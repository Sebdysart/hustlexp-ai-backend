import { describe, expect, it } from 'vitest';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  WORKER_SCREENING_DISCLOSURE_VERSION,
  WORKER_SCREENING_DISCLOSURE_HASH,
  screeningDisclosureForProvider,
  projectScreeningRights,
  validateScreeningConsent,
} from '../../src/services/WorkerScreeningRightsPolicy.js';

describe('WorkerScreeningRightsPolicy', () => {
  it('requires standalone, versioned, informed written consent', () => {
    expect(validateScreeningConsent({
      disclosureVersion: WORKER_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: WORKER_SCREENING_DISCLOSURE_HASH,
      disclosurePresentedStandalone: true,
      consentGranted: true,
      purposeAcknowledged: true,
      rightsSummaryAcknowledged: true,
      providerNamed: true,
    })).toEqual([]);
    expect(validateScreeningConsent({
      disclosureVersion: 'stale',
      disclosureHash: 'bad',
      disclosurePresentedStandalone: false,
      consentGranted: false,
      purposeAcknowledged: false,
      rightsSummaryAcknowledged: false,
      providerNamed: false,
    })).toEqual([
      'STALE_DISCLOSURE',
      'DISCLOSURE_CONTENT_MISMATCH',
      'DISCLOSURE_NOT_STANDALONE',
      'WRITTEN_CONSENT_REQUIRED',
      'PURPOSE_NOT_ACKNOWLEDGED',
      'RIGHTS_NOT_ACKNOWLEDGED',
      'SCREENING_PROVIDER_NOT_NAMED',
    ]);
  });

  it('uses a distinct disclosure that cannot imply a real provider report for local TEST screening', () => {
    const disclosure = screeningDisclosureForProvider(LOCAL_CERTIFICATION_SCREENING_PROVIDER);
    expect(disclosure).toMatchObject({
      version: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
      hash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
      isTest: true,
    });
    expect(disclosure.copy).toContain('does not order or represent a criminal-history or consumer report');
    expect(disclosure.copy).toContain('CONTROLLED_TEST');
    expect(validateScreeningConsent({
      provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
      disclosureVersion: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
      disclosurePresentedStandalone: true,
      consentGranted: true,
      purposeAcknowledged: true,
      rightsSummaryAcknowledged: true,
      providerNamed: true,
    })).toEqual([]);
    expect(validateScreeningConsent({
      provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
      disclosureVersion: WORKER_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: WORKER_SCREENING_DISCLOSURE_HASH,
      disclosurePresentedStandalone: true,
      consentGranted: true,
      purposeAcknowledged: true,
      rightsSummaryAcknowledged: true,
      providerNamed: true,
    })).toEqual(['STALE_DISCLOSURE', 'DISCLOSURE_CONTENT_MISMATCH']);
  });

  it('keeps open-category eligibility and rank neutral in every screening state', () => {
    for (const status of ['NOT_STARTED', 'PENDING', 'CONSIDER', 'DISPUTED', 'FAILED', 'CLEAR'] as const) {
      const rights = projectScreeningRights({
        status,
        reportAvailable: status !== 'NOT_STARTED',
        preAdverseNoticeDelivered: false,
        reviewWindowElapsed: false,
        openDispute: status === 'DISPUTED',
      });
      expect(rights.openCategoryEligibility).toBe('UNCHANGED');
      expect(rights.rankingAdjustment).toBe(0);
      expect(rights.paidPromotionAffectsDecision).toBe(false);
      expect(rights.restrictedCategoryEligibility).toBe(status === 'CLEAR' ? 'ELIGIBLE' : 'LOCKED');
    }
  });

  it('fails closed before adverse action until report, notice, review, and dispute gates clear', () => {
    const blocked = projectScreeningRights({
      status: 'PRE_ADVERSE',
      reportAvailable: true,
      preAdverseNoticeDelivered: true,
      reviewWindowElapsed: false,
      openDispute: true,
    });
    expect(blocked.finalAdverseActionAllowed).toBe(false);
    expect(blocked.blockers).toEqual(['REVIEW_WINDOW_OPEN', 'DISPUTE_UNRESOLVED']);

    expect(projectScreeningRights({
      status: 'PRE_ADVERSE',
      reportAvailable: true,
      preAdverseNoticeDelivered: true,
      reviewWindowElapsed: true,
      openDispute: false,
    }).finalAdverseActionAllowed).toBe(true);
  });

  it('keeps report dispute available through final action and exposes appeal afterward', () => {
    const rights = projectScreeningRights({
      status: 'FAILED',
      reportAvailable: true,
      preAdverseNoticeDelivered: true,
      reviewWindowElapsed: true,
      openDispute: false,
    });
    expect(rights.canInspectReport).toBe(true);
    expect(rights.canDispute).toBe(true);
    expect(rights.canAppeal).toBe(true);
  });
});
