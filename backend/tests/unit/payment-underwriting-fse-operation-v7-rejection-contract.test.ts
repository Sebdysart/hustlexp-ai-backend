import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_FINANCIAL_SECURITY_AUTHORITY_V7,
  PAYMENT_FINANCIAL_SECURITY_IDEMPOTENCY_PREFIX_V7,
  PAYMENT_FINANCIAL_SECURITY_OBSERVATION_SOURCES_V7,
  PAYMENT_FINANCIAL_SECURITY_PROVIDER_STATES_V7,
  paymentFinancialSecurityAgreementBlockersV7,
  paymentFinancialSecurityIdempotencyKeyV7,
} from '../../src/contracts/PaymentUnderwritingFinancialSecurityV7.js';

const root = resolve(import.meta.dirname, '../../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const hash = (character: string): string => character.repeat(64);

const apiObservation = Object.freeze({
  source: 'API_RESPONSE',
  financialSecurityEventId: '10000000-0000-4000-8000-000000000001',
  operationId: '20000000-0000-4000-8000-000000000001',
  processorCode: 'CANDIDATE_SANDBOX',
  providerOperationReferenceSha256: hash('a'),
  providerState: 'SUCCEEDED',
  amountCents: 10_000,
  currency: 'usd',
  merchantContextSha256: hash('b'),
  expiresAt: '2026-08-23T20:00:00.000Z',
  observedAt: '2026-08-22T21:00:00.000Z',
  authenticated: true,
});

describe('payment underwriting FSE operation v7', () => {
  it('pins the exact D4 source authority and closed vocabularies', () => {
    expect(PAYMENT_FINANCIAL_SECURITY_AUTHORITY_V7).toEqual({
      googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
      driveRevision: '7',
      docsRevision:
        'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
      textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
      acceptedD3Commit: 'f4c2acef976ce8e1bdf2d97c208fe5a2d47e7245',
      acceptedD3Tree: '182c2f81a1f1d02c575e559af4ab308cf1ac42f1',
      contractVersion: 7,
      operationallyEnabled: false,
    });
    expect(PAYMENT_FINANCIAL_SECURITY_IDEMPOTENCY_PREFIX_V7).toBe('hx-fse-v7:');
    expect(PAYMENT_FINANCIAL_SECURITY_OBSERVATION_SOURCES_V7).toEqual(['API_RESPONSE', 'WEBHOOK']);
    expect(PAYMENT_FINANCIAL_SECURITY_PROVIDER_STATES_V7).toEqual([
      'PENDING',
      'ACTION_REQUIRED',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
      'EXPIRED',
      'UNKNOWN',
    ]);
  });

  it('derives the operation idempotency key and requires exact API/webhook agreement', () => {
    expect(paymentFinancialSecurityIdempotencyKeyV7(apiObservation.operationId)).toBe(
      'hx-fse-v7:20000000-0000-4000-8000-000000000001'
    );
    expect(
      paymentFinancialSecurityAgreementBlockersV7(
        apiObservation,
        { ...apiObservation, source: 'WEBHOOK' },
        '2026-08-22T21:00:01.000Z'
      )
    ).toEqual([]);
    expect(
      paymentFinancialSecurityAgreementBlockersV7(
        apiObservation,
        {
          ...apiObservation,
          source: 'WEBHOOK',
          authenticated: false,
          providerOperationReferenceSha256: hash('c'),
          amountCents: 9_999,
          currency: 'eur',
          merchantContextSha256: hash('d'),
          providerState: 'PENDING',
        },
        '2026-08-24T00:00:00.000Z'
      )
    ).toEqual([
      'webhook_not_authenticated',
      'provider_operation_mismatch',
      'provider_state_not_succeeded',
      'amount_mismatch',
      'currency_mismatch',
      'merchant_context_mismatch',
      'financial_security_expired',
    ]);
  });

  it('freezes customer authority, operation identity, webhook evidence, and lifecycle barriers', () => {
    const migration = source(
      'backend/database/migrations/20260822_payment_underwriting_fse_operation_v7.sql'
    );
    for (const table of [
      'payment_financial_security_authorities_v7',
      'payment_financial_security_operation_observations_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_fse_authority_sha256_v7',
      'hxos_payment_fse_operation_material_sha256_v7',
      'hxos_payment_fse_observation_material_sha256_v7',
      'hxos_payment_fse_agreement_sha256_v7',
      'hxos_reject_payment_underwriting_d4_mutation_v7',
      'hxos_enforce_payment_fse_authority_v7',
      'hxos_enforce_payment_fse_operation_v7',
      'hxos_enforce_payment_fse_observation_v7',
      'hxos_enforce_payment_fse_lifecycle_transition_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain('payment_financial_security_status_v7');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS payment_financial_security_authority_id UUID'
    );
    expect(migration).toContain(
      'ALTER COLUMN payment_financial_security_authority_id SET NOT NULL'
    );
    expect(migration).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(migration).toContain("'hx-fse-v7:' || NEW.operation_id::TEXT");
    expect(migration).toContain('v_d4_catalog_complete BOOLEAN');
    expect(migration).toContain('v_d4_catalog_absent BOOLEAN');
    expect(migration).toContain('v_invalid_authority_count BIGINT := 0');
    expect(migration).toContain('v_invalid_operation_count BIGINT := 0');
    expect(migration).toContain('v_invalid_observation_count BIGINT := 0');
    expect(migration).toContain('v_pre_d5_consumed_hold_count BIGINT := 0');
    expect(migration).toContain('authority.approved_at < hold.accepted_at');
    expect(migration).toContain('authority.expires_at > hold.expires_at');
    expect(migration).toContain('operation.created_at < authority.approved_at');
    expect(migration).toContain('operation.expires_at > hold.expires_at');
    expect(migration).toContain('observation.observed_at < operation.created_at');
    expect(migration).toContain('observation.provider_expires_at > hold.expires_at');
    expect(migration).toContain("hold_event.event_type = 'CONSUMED'");
    expect(migration).toContain('payment_canonical_work_orders_v7 work_order');
    expect(migration).toContain('D4 populated upgrade violates successor invariants');
    expect(migration).toContain('OR NEW.expires_at > v_hold.expires_at');
    expect(migration).toContain('OR NEW.approved_at < v_hold.accepted_at');
    expect(migration).toContain('OR NEW.expires_at > v_hold_expires_at');
    expect(migration).toContain('OR NEW.created_at < v_authority.approved_at');
    expect(migration).toContain('OR NEW.observed_at < v_fse.created_at');
    expect(migration).toContain('OR v_fse.expires_at <= clock_timestamp()');
    expect(migration).toContain('OR v_hold_expires_at <= clock_timestamp()');
    expect(migration).toContain('hold consumption is deferred to D5 atomic materialization');
    expect(migration).toContain('payment_financial_security_events_v7_one_per_lifecycle_d4_uq');
    expect(migration).toContain(
      "source TEXT NOT NULL CHECK (source IN ('API_RESPONSE', 'WEBHOOK'))"
    );
    expect(migration).toContain("v_webhook.authentication_state <> 'VERIFIED'");
    expect(migration).toContain("v_status.agreement_state IS DISTINCT FROM 'AGREED'");
    expect(migration).toContain('NEW.evidence_sha256 IS DISTINCT FROM v_status.agreement_sha256');
    expect(migration).toContain("NEW.stage = 'WORK_ORDER_MATERIALIZED'");
    expect(migration).toContain('HXPV49');
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create|capture\(/i);
  });

  it('keeps D4 outside startup and defers work order, capture, and settlement authority', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260822_payment_underwriting_fse_operation_v7');

    const manifest = JSON.parse(
      source('docs/underwriting/payment-underwriting-d4-fse-operation-v7.json')
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D4_FSE_OPERATION_IDEMPOTENCY_WEBHOOK',
      parentCommit: 'e7ffb4a9e0a1d98b5a6d61eec56514bde742d343',
      rejectedPredecessorCommit: 'e7ffb4a9e0a1d98b5a6d61eec56514bde742d343',
      acceptedDependencyCommit: 'f4c2acef976ce8e1bdf2d97c208fe5a2d47e7245',
      acceptedDependencyTree: '182c2f81a1f1d02c575e559af4ab308cf1ac42f1',
      migration: '20260822_payment_underwriting_fse_operation_v7',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
    });
    expect(manifest.deferredDependencies).toEqual([
      'D5_ATOMIC_WORK_ORDER_ASSIGNMENT_ADDRESS',
      'D6_COMPLETION_APPROVAL_MANUAL_CAPTURE',
      'D7_SETTLEMENT_DOUBLE_ENTRY_RECONCILE_CLOSE',
      'D8_VARIANTS',
    ]);
  });
});
