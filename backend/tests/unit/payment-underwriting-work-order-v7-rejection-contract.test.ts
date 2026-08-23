import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_PRIVATE_FULFILLMENT_SCOPE_V7,
  PAYMENT_WORK_ORDER_AUTHORITY_V7,
  paymentWorkOrderMaterializationBlockersV7,
} from '../../src/contracts/PaymentUnderwritingWorkOrderV7.js';

const root = resolve(import.meta.dirname, '../../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const validInput = Object.freeze({
  lifecycleStage: 'FINANCIALLY_SECURED',
  agreementState: 'AGREED',
  providerState: 'SUCCEEDED',
  financialSecurityExpiresAt: '2026-08-23T22:00:00.000Z',
  holdState: 'SOFT_RESERVED',
  holdExpiresAt: '2026-08-23T22:00:00.000Z',
  taskDraftTaskId: '10000000-0000-4000-8000-000000000001',
  taskId: '10000000-0000-4000-8000-000000000001',
  customerUserId: '20000000-0000-4000-8000-000000000001',
  taskPosterUserId: '20000000-0000-4000-8000-000000000001',
  providerUserId: '30000000-0000-4000-8000-000000000001',
  assignedProviderUserId: '30000000-0000-4000-8000-000000000001',
  assignmentPresent: true,
  sealedLocationPresent: true,
});

describe('payment underwriting work-order materialization v7', () => {
  it('pins the exact D5 source authority and private fulfillment scope', () => {
    expect(PAYMENT_WORK_ORDER_AUTHORITY_V7).toEqual({
      googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
      driveRevision: '7',
      docsRevision:
        'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
      textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
      acceptedD4Commit: 'b5bf643def5365312a8e08d845f42afc6e79252d',
      acceptedD4Tree: 'b4ff045172abe0160d080cdf3eac7618335489a2',
      contractVersion: 7,
      operationallyEnabled: false,
    });
    expect(PAYMENT_PRIVATE_FULFILLMENT_SCOPE_V7).toBe('EXACT_FULFILLMENT_LOCATION');
  });

  it('derives every materialization blocker without private plaintext', () => {
    expect(
      paymentWorkOrderMaterializationBlockersV7(validInput, '2026-08-23T21:00:00.000Z')
    ).toEqual([]);
    expect(
      paymentWorkOrderMaterializationBlockersV7(
        {
          ...validInput,
          lifecycleStage: 'FINANCIAL_SECURITY_PENDING',
          agreementState: 'UNRESOLVED',
          providerState: 'PENDING',
          financialSecurityExpiresAt: '2026-08-23T20:59:59.000Z',
          holdState: 'RELEASED',
          holdExpiresAt: '2026-08-23T20:59:59.000Z',
          taskDraftTaskId: '40000000-0000-4000-8000-000000000001',
          taskPosterUserId: '40000000-0000-4000-8000-000000000002',
          assignedProviderUserId: '40000000-0000-4000-8000-000000000003',
          assignmentPresent: false,
          sealedLocationPresent: false,
        },
        '2026-08-23T21:00:00.000Z'
      )
    ).toEqual([
      'lifecycle_not_financially_secured',
      'financial_security_agreement_unresolved',
      'financial_security_provider_not_succeeded',
      'financial_security_expired',
      'hold_not_soft_reserved',
      'hold_expired',
      'task_not_bound_to_draft',
      'customer_mismatch',
      'provider_mismatch',
      'assignment_missing',
      'sealed_location_missing',
    ]);
  });

  it('requires one deferred all-or-nothing work-order graph and compensation rail', () => {
    const migration = source(
      'backend/database/migrations/20260823_payment_underwriting_work_order_materialization_v7.sql'
    );
    for (const table of [
      'payment_work_order_materialization_authorities_v7',
      'payment_work_order_assignments_v7',
      'payment_private_fulfillment_grants_v7',
      'payment_private_fulfillment_access_events_v7',
      'payment_work_order_void_obligations_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_work_order_materialization_authority_sha256_v7',
      'hxos_payment_work_order_assignment_sha256_v7',
      'hxos_payment_private_fulfillment_grant_sha256_v7',
      'hxos_payment_private_fulfillment_access_event_sha256_v7',
      'hxos_payment_work_order_void_obligation_sha256_v7',
      'hxos_assert_payment_private_fulfillment_access_history_v7',
      'hxos_reject_payment_underwriting_d5_mutation_v7',
      'hxos_enforce_payment_work_order_materialization_authority_v7',
      'hxos_enforce_payment_canonical_work_order_v7',
      'hxos_enforce_payment_work_order_assignment_v7',
      'hxos_enforce_payment_private_fulfillment_grant_v7',
      'hxos_enforce_payment_work_order_void_obligation_v7',
      'hxos_enforce_payment_work_order_materialization_bundle_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain("agreement_state IS DISTINCT FROM 'AGREED'");
    expect(migration).toContain("provider_state IS DISTINCT FROM 'SUCCEEDED'");
    expect(migration).toContain("hold_state IS DISTINCT FROM 'SOFT_RESERVED'");
    expect(migration).toContain("event_type = 'CONSUMED'");
    expect(migration).toContain("stage = 'WORK_ORDER_MATERIALIZED'");
    expect(migration).toContain("stage = 'ASSIGNED'");
    expect(migration).toContain('task_location_vault');
    expect(migration).toContain('location_fingerprint');
    expect(migration).toContain('lag(accessed_at) OVER');
    expect(migration).toContain('access.accessed_at >= vault.expired_at');
    expect(migration).toContain('access.created_at >= vault.expired_at');
    expect(migration).toContain(
      'SELECT hxos_assert_payment_private_fulfillment_access_history_v7()'
    );
    expect(migration).toContain('HXPV59');
    expect(migration).not.toMatch(
      /exact_location|customer_email|customer_phone|access_instructions/i
    );
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create|capture\(/i);
  });

  it('keeps D5 outside startup and defers capture, settlement, and payout', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260823_payment_underwriting_work_order_materialization_v7');

    const manifest = JSON.parse(
      source('docs/underwriting/payment-underwriting-d5-work-order-v7.json')
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D5_ATOMIC_WORK_ORDER_ASSIGNMENT_ADDRESS',
      parentCommit: 'b5bf643def5365312a8e08d845f42afc6e79252d',
      acceptedDependencyCommit: 'b5bf643def5365312a8e08d845f42afc6e79252d',
      acceptedDependencyTree: 'b4ff045172abe0160d080cdf3eac7618335489a2',
      migration: '20260823_payment_underwriting_work_order_materialization_v7',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
    });
    expect(manifest.deferredDependencies).toEqual([
      'D6_COMPLETION_APPROVAL_MANUAL_CAPTURE',
      'D7_SETTLEMENT_DOUBLE_ENTRY_RECONCILE_CLOSE',
      'D8_VARIANTS',
    ]);
  });
});
