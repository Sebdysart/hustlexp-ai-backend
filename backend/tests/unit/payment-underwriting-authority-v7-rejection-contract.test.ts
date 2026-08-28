import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  PAYMENT_UNDERWRITING_DECISION_IDS_V7,
  PAYMENT_UNDERWRITING_AUTHORITY_V7,
  unresolvedPaymentUnderwritingDecisionsV7,
} from '../../src/contracts/PaymentUnderwritingAuthorityV7.js';

const traceability = JSON.parse(
  readFileSync('docs/underwriting/payment-underwriting-d0-d1-authority-freeze-v7.json', 'utf8')
) as Record<string, unknown>;

const expectedProductionFiles = [
  'backend/src/config.ts',
  'backend/src/contracts/PaymentUnderwritingAuthorityV7.ts',
  'backend/src/jobs/engine-automation-migration-files.ts',
  'backend/src/jobs/engine-migration-manifest.ts',
  'backend/src/jobs/payment-worker.ts',
  'backend/src/jobs/stripe-event-worker.ts',
  'backend/src/routers/escrow-payment-procedures.ts',
  'backend/src/routers/quotePayment.ts',
  'backend/src/routers/subscription.ts',
  'backend/src/routers/xpTax.ts',
  'backend/src/services/LocalCertificationPaymentProvider.ts',
  'backend/src/services/NewPaymentCreationGuard.ts',
  'backend/src/services/QuoteGenerationService.ts',
  'backend/src/services/QuotePaymentFinalizationService.ts',
  'backend/src/services/QuotePaymentRecoveryService.ts',
  'backend/src/services/StripeService.ts',
  'backend/src/services/TippingService.ts',
  'backend/src/services/XPTaxService.ts',
  'backend/src/services/payment/LegacyQuotePaymentRecoveryPort.ts',
  'backend/src/services/payment/QuotePaymentProvider.ts',
  'backend/src/services/payment/QuotePaymentRecoveryProviderResolver.ts',
  'backend/src/services/payment/StripeQuotePaymentProvider.ts',
] as const;

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
      stack: {
        migration: {
          disposition: string;
          name: string;
          file: string;
          registry: string;
          requiredChainLength: number;
        };
      };
      productionFiles: string[];
      deferredDependencies: unknown[];
    };
    expect(manifest.invariants).toHaveLength(7);
    expect(manifest.guard.lanes).toHaveLength(6);
    expect(manifest.guard.authorityCode).toBe('UNDERWRITING_DECISIONS_UNRESOLVED');
    expect(manifest.stack.migration).toEqual({
      disposition: 'FROZEN_RECOVERY_AND_RECONCILIATION_ONLY',
      name: '20260823_quote_payment_recovery',
      file: 'backend/database/migrations/20260823_quote_payment_recovery.sql',
      registry: 'backend/src/jobs/engine-automation-migration-files.ts',
      requiredChainLength: 104,
    });
    const frozenAuthorityChain = REQUIRED_MIGRATION_FILES.slice(
      0,
      manifest.stack.migration.requiredChainLength
    );
    expect(frozenAuthorityChain).toHaveLength(manifest.stack.migration.requiredChainLength);
    expect(frozenAuthorityChain.at(-1)).toEqual({
      name: manifest.stack.migration.name,
      fileName: '20260823_quote_payment_recovery.sql',
    });
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(121);
    expect(REQUIRED_MIGRATION_FILES.slice(manifest.stack.migration.requiredChainLength))
      .toEqual([
        {
          name: '20260827_universal_v1_lifecycle_contract',
          fileName: '20260827_universal_v1_lifecycle_contract.sql',
        },
        {
          name: '20260828_operator_authority_contract',
          fileName: '20260828_operator_authority_contract.sql',
        },
        {
          name: '20260829_task_matching_state_contract',
          fileName: '20260829_task_matching_state_contract.sql',
        },
        {
          name: '20260830_ai_agent_judge_audit_convergence',
          fileName: '20260830_ai_agent_judge_audit_convergence.sql',
        },
        {
          name: '20260831_provider_neutral_outbound_communication',
          fileName: '20260831_provider_neutral_outbound_communication.sql',
        },
        {
          name: '20260901_universal_v1_lead_ingress_port',
          fileName: '20260901_universal_v1_lead_ingress_port.sql',
        },
        {
          name: '20260902_universal_v1_task_draft_public_port',
          fileName: '20260902_universal_v1_task_draft_public_port.sql',
        },
        {
          name: '20260903_universal_v1_task_draft_account_claim',
          fileName: '20260903_universal_v1_task_draft_account_claim.sql',
        },
        {
          name: '20260904_canonical_user_email_identity',
          fileName: '20260904_canonical_user_email_identity.sql',
        },
        {
          name: '20260905_universal_v1_task_draft_legacy_claim_import_repair',
          fileName: '20260905_universal_v1_task_draft_legacy_claim_import_repair.sql',
        },
        {
          name: '20260906_universal_v1_estimate_acceptance_materialization',
          fileName: '20260906_universal_v1_estimate_acceptance_materialization.sql',
        },
        {
          name: '20260907_universal_v1_provider_estimate_invitation',
          fileName: '20260907_universal_v1_provider_estimate_invitation.sql',
        },
        {
          name: '20260908_universal_v1_provider_work_order_authority',
          fileName: '20260908_universal_v1_provider_work_order_authority.sql',
        },
        {
          name: '20260909_universal_v1_reconciliation_alias_repair',
          fileName: '20260909_universal_v1_reconciliation_alias_repair.sql',
        },
        {
          name: '20260911_universal_v1_change_order_application',
          fileName: '20260911_universal_v1_change_order_application.sql',
        },
        {
          name: '20260912_universal_v1_work_order_execution_facts',
          fileName: '20260912_universal_v1_work_order_execution_facts.sql',
        },
        {
          name: '20260913_universal_v1_completion_delivery_receipt',
          fileName: '20260913_universal_v1_completion_delivery_receipt.sql',
        },
      ]);
    expect(existsSync(manifest.stack.migration.file)).toBe(true);
    expect(existsSync(manifest.stack.migration.registry)).toBe(true);
    expect(manifest.productionFiles).toEqual(expectedProductionFiles);
    for (const fileName of manifest.productionFiles) {
      expect(existsSync(fileName), fileName).toBe(true);
    }
    expect(manifest.deferredDependencies).toHaveLength(7);
  });
});
