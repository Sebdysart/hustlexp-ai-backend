import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_UNDERWRITING_CANONICAL_OBJECTS_V7,
  PAYMENT_UNDERWRITING_LIFECYCLE_STAGES_V7,
  PAYMENT_UNDERWRITING_STAGE_TRANSITIONS_V7,
  PAYMENT_UNDERWRITING_SCHEMA_AUTHORITY_V7,
  isPaymentUnderwritingTransitionV7,
} from '../../src/contracts/PaymentUnderwritingLifecycleV7.js';

const root = resolve(import.meta.dirname, '../../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const exactStages = [
  'TASK_DRAFT',
  'SCOPE_READY',
  'QUOTED',
  'ESTIMATE_REQUIRED',
  'QUOTE_APPROVED',
  'PAYMENT_METHOD_READY',
  'PROVIDER_SOURCING',
  'PAYMENT_ELIGIBLE',
  'PROVIDER_SOFT_RESERVED',
  'FINANCIAL_SECURITY_PENDING',
  'FINANCIALLY_SECURED',
  'WORK_ORDER_MATERIALIZED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETION_SUBMITTED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'SETTLING',
  'PAYOUT_PENDING',
  'FUNDED',
  'PAID_OUT',
  'RECONCILED',
  'CLOSED',
] as const;

const exactObjects = [
  'TaskDraftLifecycle',
  'TaskOpportunity',
  'ProviderAccountRef',
  'ConditionalProviderHold',
  'PaymentMethodRef',
  'FinancialSecurityEvent',
  'CanonicalWorkOrder',
  'PaymentCapture',
  'LedgerTransaction',
  'LedgerEntry',
  'SettlementRecord',
  'WebhookInbox',
  'ReconciliationRun',
  'LegacyPaymentClassification',
] as const;

describe('payment underwriting neutral lifecycle v7', () => {
  it('pins the exact source authority and remains operationally inert', () => {
    expect(PAYMENT_UNDERWRITING_SCHEMA_AUTHORITY_V7).toEqual({
      googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
      driveRevision: '7',
      docsRevision:
        'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
      textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
      contractVersion: 7,
      operationallyEnabled: false,
    });
  });

  it('freezes the complete typed lifecycle and legal adjacency', () => {
    expect(PAYMENT_UNDERWRITING_LIFECYCLE_STAGES_V7).toEqual(exactStages);
    expect(PAYMENT_UNDERWRITING_STAGE_TRANSITIONS_V7).toEqual({
      TASK_DRAFT: ['SCOPE_READY'],
      SCOPE_READY: ['QUOTED', 'ESTIMATE_REQUIRED'],
      QUOTED: ['QUOTE_APPROVED'],
      ESTIMATE_REQUIRED: ['QUOTE_APPROVED'],
      QUOTE_APPROVED: ['PAYMENT_METHOD_READY'],
      PAYMENT_METHOD_READY: ['PROVIDER_SOURCING'],
      PROVIDER_SOURCING: ['PAYMENT_ELIGIBLE'],
      PAYMENT_ELIGIBLE: ['PROVIDER_SOFT_RESERVED'],
      PROVIDER_SOFT_RESERVED: ['FINANCIAL_SECURITY_PENDING'],
      FINANCIAL_SECURITY_PENDING: ['FINANCIALLY_SECURED'],
      FINANCIALLY_SECURED: ['WORK_ORDER_MATERIALIZED'],
      WORK_ORDER_MATERIALIZED: ['ASSIGNED'],
      ASSIGNED: ['IN_PROGRESS'],
      IN_PROGRESS: ['COMPLETION_SUBMITTED'],
      COMPLETION_SUBMITTED: ['CAPTURE_PENDING'],
      CAPTURE_PENDING: ['CAPTURED'],
      CAPTURED: ['SETTLING', 'PAYOUT_PENDING'],
      SETTLING: ['FUNDED'],
      PAYOUT_PENDING: ['PAID_OUT'],
      FUNDED: ['RECONCILED'],
      PAID_OUT: ['RECONCILED'],
      RECONCILED: ['CLOSED'],
      CLOSED: [],
    });

    for (const pricingLane of ['PLATFORM_PRICED', 'PROVIDER_ESTIMATE'] as const) {
      for (const from of exactStages) {
        for (const to of exactStages) {
          const expected =
            from === 'SCOPE_READY'
              ? to === (pricingLane === 'PLATFORM_PRICED' ? 'QUOTED' : 'ESTIMATE_REQUIRED')
              : PAYMENT_UNDERWRITING_STAGE_TRANSITIONS_V7[from].includes(to as never);
          expect(isPaymentUnderwritingTransitionV7(pricingLane, from, to)).toBe(expected);
        }
      }
    }
    expect(isPaymentUnderwritingTransitionV7('PLATFORM_PRICED', 'CAPTURE_PENDING', 'CLOSED')).toBe(
      false
    );
    expect(isPaymentUnderwritingTransitionV7('PROVIDER_ESTIMATE', 'CLOSED', 'TASK_DRAFT')).toBe(
      false
    );
  });

  it('defines every processor-neutral object without enabling runtime money authority', () => {
    expect(PAYMENT_UNDERWRITING_CANONICAL_OBJECTS_V7).toEqual(exactObjects);

    const migration = source(
      'backend/database/migrations/20260820_payment_underwriting_neutral_lifecycle_v7.sql'
    );
    for (const table of [
      'payment_underwriting_lifecycles_v7',
      'payment_underwriting_lifecycle_events_v7',
      'payment_task_opportunities_v7',
      'payment_provider_account_refs_v7',
      'payment_conditional_provider_holds_v7',
      'payment_method_refs_v7',
      'payment_financial_security_events_v7',
      'payment_canonical_work_orders_v7',
      'payment_captures_v7',
      'payment_ledger_transactions_v7',
      'payment_ledger_entries_v7',
      'payment_settlement_records_v7',
      'payment_webhook_inbox_v7',
      'payment_reconciliation_runs_v7',
      'payment_legacy_classifications_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain('hxos_reject_payment_underwriting_event_mutation_v7');
    expect(migration).toContain('hxos_enforce_payment_underwriting_transition_v7');
    expect(migration).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
    expect(migration).toContain('FOREIGN KEY (task_draft_id, customer_user_id)');
    expect(migration).toContain('FOREIGN KEY (task_draft_id, poster_user_id)');
    expect(migration).toContain('FOREIGN KEY (opportunity_id, lifecycle_id)');
    expect(migration).toContain('FOREIGN KEY (hold_id, lifecycle_id, provider_account_ref_id)');
    expect(migration).toContain('FOREIGN KEY (lifecycle_id, task_draft_id)');
    expect(migration).toContain(
      'FOREIGN KEY (payment_method_ref_id, customer_user_id, processor_code)'
    );
    expect(migration).toContain('FOREIGN KEY (task_draft_id, customer_user_id, task_id)');
    expect(migration).toContain('FOREIGN KEY (task_id, customer_user_id)');
    expect(migration).toContain(
      'financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,'
    );
    expect(migration).toContain(
      'FOREIGN KEY (work_order_id, lifecycle_id, financial_security_event_id, processor_code)'
    );
    expect(migration).toContain('FOREIGN KEY (capture_id, lifecycle_id, processor_code)');
    expect(
      migration.match(/state TEXT NOT NULL DEFAULT 'PLANNED' CHECK \(state = 'PLANNED'\)/g)
    ).toHaveLength(2);
    expect(migration).toContain("lifecycle_record.pricing_lane = 'PLATFORM_PRICED'");
    expect(migration).toContain("actor_type = 'POSTER'");
    expect(migration).toContain('poster_user_id IS NOT NULL');
    expect(migration).toContain("actor_type IN ('PROVIDER', 'ADMIN')");
    expect(migration).toContain("actor_type IN ('SYSTEM', 'WEBHOOK', 'RECONCILER')");
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)/i);
    expect(migration).not.toMatch(/paymentIntents|subscriptions\.create|refunds\.create/i);
  });

  it('keeps the schema artifact out of runtime startup and binds the D2 traceability manifest', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260820_payment_underwriting_neutral_lifecycle_v7');

    const manifest = JSON.parse(
      source('docs/underwriting/payment-underwriting-d2-neutral-lifecycle-v7.json')
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D2_NEUTRAL_SCHEMA_AND_TYPED_LIFECYCLE',
      parentCommit: 'dda6ebda31c07c9afdd4b8b68fe2a698790f424d',
      acceptedDependencyCommit: '567f5a848d7045d5ec5958bd7ba677217e13b9ab',
      rejectedCandidateCommit: '9f27438db9c8fc6bfedb709b85a774e94c6c8f02',
      migration: '20260820_payment_underwriting_neutral_lifecycle_v7',
      operationallyEnabled: false,
      startupRegistered: false,
      runtimeAuthority: 'NOT_RUNTIME_APPLIED_PENDING_AUTHORITY_CALLABLES',
      customerBinding: 'TASK_DRAFT_POSTER_TO_PAYMENT_METHOD',
    });
  });
});
