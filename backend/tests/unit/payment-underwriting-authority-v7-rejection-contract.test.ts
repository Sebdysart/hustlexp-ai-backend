import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_UNDERWRITING_DECISION_IDS_V7,
  PAYMENT_UNDERWRITING_AUTHORITY_V7,
  unresolvedPaymentUnderwritingDecisionsV7,
} from '../../src/contracts/PaymentUnderwritingAuthorityV7.js';

const traceability = JSON.parse(
  readFileSync('docs/underwriting/payment-underwriting-d0-d1-authority-freeze-v7.json', 'utf8')
) as Record<string, unknown>;

describe('payment underwriting authority v7', () => {
  it('pins the exact authoritative document export and current-main stack base', () => {
    expect(PAYMENT_UNDERWRITING_AUTHORITY_V7).toEqual(
      expect.objectContaining({
        googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
        driveRevision: '7',
        docsRevision:
          'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
        textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
        textPlainUtf8Bytes: 71_231,
        currentMainBase: 'ab4a76cbc8ea32c663c36982eafe94b20d2dc879',
        productionDecision: 'NO_GO',
        processorSpecificMoneyCreation: 'DISABLED_PENDING_WRITTEN_APPROVAL',
      })
    );
  });

  it('keeps all twenty written processor decisions unresolved and executable as a deny', () => {
    expect(unresolvedPaymentUnderwritingDecisionsV7()).toEqual([
      'SOLE_PROPRIETOR_PROVIDER_ELIGIBILITY',
      'PROVIDER_BANK_ACCOUNT_ELIGIBILITY',
      'MARKETPLACE_PROVIDER_OS_RELATIONSHIP',
      'MERCHANT_OF_RECORD_AND_SUPPORT_TOPOLOGY',
      'CONDITIONAL_PROVIDER_ACCEPTANCE_BEFORE_FSE',
      'CAPTURE_AND_DISBURSEMENT_MODEL',
      'TOKENIZATION_CONSENT_AND_PORTABILITY',
      'PLATFORM_ECONOMICS',
      'AMOUNT_CHANGE_AUTHORITY',
      'PROVIDER_REPLACEMENT_AUTHORITY',
      'LOSS_ALLOCATION_WATERFALL',
      'PROVIDER_PLATFORM_RISK_ISOLATION',
      'CATEGORY_AND_MCC_APPROVAL',
      'LIMITS_RESERVES_SETTLEMENT_AND_CAPACITY',
      'RESTRICTION_AND_TERMINATION_CONTINUITY',
      'RECURRING_OCCURRENCE_MODEL',
      'REGULATORY_ROLE_AND_LICENSING',
      'COMMERCIAL_TERMS',
      'TASK_OPPORTUNITY_ONBOARDING',
      'WRITTEN_ARCHITECTURE_SIGNOFF',
    ]);
    expect(PAYMENT_UNDERWRITING_AUTHORITY_V7.decisions).toSatisfy(
      (decisions: Readonly<Record<string, string>>) =>
        Object.values(decisions).every((status) => status === 'UNRESOLVED')
    );
  });

  it('excludes the superseded and conflicting open pull-request heads', () => {
    expect(PAYMENT_UNDERWRITING_AUTHORITY_V7.excludedPullRequests).toEqual({
      263: {
        head: 'ce0e622c8ff2069239768d4172a12be531a90061',
        disposition: 'SUPERSEDED',
      },
      265: {
        head: '9cc7f6a7596dacd5f91112ddee61189bf60a1fc8',
        disposition: 'REJECTED_CONFLICTING',
      },
    });
  });

  it('ships one machine-readable D0+D1 traceability manifest bound to the executable authority', () => {
    expect(traceability).toEqual(
      expect.objectContaining({
        schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
        slice: 'D0_D1_AUTHORITY_FREEZE',
        sourceAuthority: expect.objectContaining({
          googleDocId: PAYMENT_UNDERWRITING_AUTHORITY_V7.googleDocId,
          driveRevision: PAYMENT_UNDERWRITING_AUTHORITY_V7.driveRevision,
          docsRevision: PAYMENT_UNDERWRITING_AUTHORITY_V7.docsRevision,
          textPlainSha256: PAYMENT_UNDERWRITING_AUTHORITY_V7.textPlainSha256,
          textPlainUtf8Bytes: PAYMENT_UNDERWRITING_AUTHORITY_V7.textPlainUtf8Bytes,
        }),
        unresolvedDecisions: [...PAYMENT_UNDERWRITING_DECISION_IDS_V7],
        productionDecision: PAYMENT_UNDERWRITING_AUTHORITY_V7.productionDecision,
        processorSpecificMoneyCreation:
          PAYMENT_UNDERWRITING_AUTHORITY_V7.processorSpecificMoneyCreation,
      })
    );

    const manifest = traceability as {
      invariants: unknown[];
      guard: { lanes: unknown[]; authorityCode: string };
      stack: { migration: string };
      deferredDependencies: unknown[];
    };
    expect(manifest.invariants).toHaveLength(7);
    expect(manifest.guard.lanes).toHaveLength(6);
    expect(manifest.guard.authorityCode).toBe('UNDERWRITING_DECISIONS_UNRESOLVED');
    expect(manifest.stack.migration).toBe('NONE_CONTAINMENT_ONLY');
    expect(manifest.deferredDependencies).toHaveLength(7);
  });
});
