import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_COMPLETION_CAPTURE_AUTHORITY_V7,
  paymentCompletionCaptureBlockersV7,
} from '../../src/contracts/PaymentUnderwritingCompletionCaptureV7.js';

const root = resolve(import.meta.dirname, '../../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const validInput = Object.freeze({
  lifecycleStage: 'COMPLETION_SUBMITTED',
  taskState: 'PROOF_SUBMITTED',
  completionEvidencePresent: true,
  completionWorkOrderId: '10000000-0000-4000-8000-000000000001',
  workOrderId: '10000000-0000-4000-8000-000000000001',
  posterApprovalState: 'APPROVED',
  customerNoticeState: 'ACKNOWLEDGED',
  amountApprovalState: 'APPROVED',
  approvedAmountCents: 10_000,
  financialSecurityAmountCents: 10_000,
  approvedCurrency: 'usd',
  financialSecurityCurrency: 'usd',
  incidentClearanceState: 'CLEAR',
  financialSecurityAgreementState: 'AGREED',
  financialSecurityExpiresAt: '2026-08-24T22:00:00.000Z',
  captureAlreadyPlanned: false,
});

describe('payment underwriting completion and capture v7', () => {
  it('pins D6 to the accepted D5 identity and exact document revision', () => {
    expect(PAYMENT_COMPLETION_CAPTURE_AUTHORITY_V7).toEqual({
      googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
      driveRevision: '7',
      docsRevision:
        'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
      textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
      acceptedD5Commit: '9ba77a24ec23a5de8c9193655894d25b4e67a9c0',
      acceptedD5Tree: '80b67e44db9d159dfa96d4b6303448e98cb3cb4f',
      contractVersion: 7,
      operationallyEnabled: false,
    });
  });

  it('derives every completion, amount, incident, FSE, and idempotency blocker', () => {
    expect(paymentCompletionCaptureBlockersV7(validInput, '2026-08-24T21:00:00.000Z')).toEqual([]);
    expect(
      paymentCompletionCaptureBlockersV7(
        {
          ...validInput,
          lifecycleStage: 'IN_PROGRESS',
          taskState: 'ACCEPTED',
          completionEvidencePresent: false,
          completionWorkOrderId: '20000000-0000-4000-8000-000000000001',
          posterApprovalState: 'PENDING',
          customerNoticeState: 'PENDING',
          amountApprovalState: 'PENDING',
          approvedAmountCents: 0,
          financialSecurityAmountCents: 10_000,
          approvedCurrency: 'cad',
          incidentClearanceState: 'BLOCKED',
          financialSecurityAgreementState: 'UNRESOLVED',
          financialSecurityExpiresAt: '2026-08-24T20:59:59.000Z',
          captureAlreadyPlanned: true,
        },
        '2026-08-24T21:00:00.000Z'
      )
    ).toEqual([
      'lifecycle_not_completion_submitted',
      'task_not_proof_submitted',
      'completion_evidence_missing',
      'completion_work_order_mismatch',
      'poster_approval_missing',
      'customer_notice_missing',
      'amount_approval_missing',
      'amount_invalid',
      'amount_mismatch',
      'currency_mismatch',
      'incident_clearance_missing',
      'financial_security_agreement_unresolved',
      'financial_security_expired',
      'capture_already_planned',
    ]);
  });

  it('requires immutable completion, approval, capture authority, and provider agreement', () => {
    const migration = source(
      'backend/database/migrations/20260824_payment_underwriting_completion_capture_v7.sql'
    );
    for (const table of [
      'payment_completion_evidence_v7',
      'payment_completion_approvals_v7',
      'payment_capture_authorities_v7',
      'payment_capture_operation_observations_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_completion_evidence_sha256_v7',
      'hxos_payment_completion_approval_sha256_v7',
      'hxos_payment_capture_authority_sha256_v7',
      'hxos_payment_capture_operation_sha256_v7',
      'hxos_payment_capture_observation_sha256_v7',
      'hxos_payment_capture_agreement_sha256_v7',
      'hxos_enforce_payment_completion_evidence_v7',
      'hxos_enforce_payment_completion_approval_v7',
      'hxos_enforce_payment_capture_authority_v7',
      'hxos_enforce_payment_capture_operation_v7',
      'hxos_enforce_payment_capture_observation_v7',
      'hxos_enforce_payment_capture_lifecycle_transition_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain('payment_assignment_d6_completion_binding_uq');
    expect(migration).toContain('payment_work_order_d6_capture_authority_binding_uq');
    expect(migration).toContain('payment_completion_d6_approval_binding_uq');
    expect(migration).toContain('payment_approval_d6_capture_authority_binding_uq');
    expect(migration).toContain('payment_captures_v7_d6_authority_uq');
    expect(migration).toContain("'completionEvidenceSha256', p_completion_evidence_sha256");
    expect(migration).toContain("'amountApprovalSha256', p_amount_approval_sha256");
    expect(migration).toContain("'incidentClearanceSha256', p_incident_clearance_sha256");
    expect(migration).toContain(
      'assignment_id, work_order_id, lifecycle_id, task_id,\n    provider_account_ref_id, provider_user_id'
    );
    expect(migration).toContain("stage = 'COMPLETION_SUBMITTED'");
    expect(migration).toContain("approval_state = 'APPROVED'");
    expect(migration).toContain('customer_notice_state');
    expect(migration).toContain('customer_notice_sha256');
    expect(migration).toContain('NEW.approved_amount_cents IS DISTINCT FROM v_fse_amount');
    expect(migration).toContain(
      'v_webhook.event_id_sha256 IS DISTINCT FROM NEW.provider_event_id_sha256'
    );
    expect(migration).toContain('NEW.observed_at < v_latest.observed_at');
    expect(migration).toContain('v_authority.expires_at <= v_now');
    expect(migration).toContain("NEW.created_at < v_now - INTERVAL '5 seconds'");
    expect(migration).toContain(
      'NEW.completion_evidence_sha256 IS DISTINCT FROM v_completion.completion_material_sha256'
    );
    expect(migration).toContain(
      'NEW.amount_approval_sha256 IS DISTINCT FROM v_approval.amount_approval_sha256'
    );
    expect(migration).toContain(
      'NEW.incident_clearance_sha256 IS DISTINCT FROM v_approval.incident_clearance_sha256'
    );
    expect(migration).toContain("incident_clearance_state = 'CLEAR'");
    expect(migration).toContain("provider_state = 'SUCCEEDED'");
    expect(migration).toContain("stage = 'CAPTURE_PENDING'");
    expect(migration).toContain("stage = 'CAPTURED'");
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create|capture\(/i);

    const pgContract = source(
      'backend/tests/integration/payment-underwriting-completion-capture-v7.pg.sql'
    );
    expect(pgContract).toContain('HXP_D6_COMPOSED');
    expect(pgContract).toContain('missing_notice_rejected');
    expect(pgContract).toContain('amount_mismatch_rejected');
    expect(pgContract).toContain('expired_authority_rejected');
    expect(pgContract).toContain('stale_operation_rejected');
    expect(pgContract).toContain('crossed_capture_evidence_rejected');
    expect(pgContract).toContain('regressed_observation_rejected');
    expect(pgContract).toContain('webhook_hash_rejected');
    expect(pgContract).toContain("lifecycle_stage IS DISTINCT FROM 'CAPTURED'");
    expect(pgContract).toContain(
      '\\ir ../../database/migrations/20260824_payment_underwriting_completion_capture_v7.sql'
    );
  });

  it('keeps D6 outside startup and defers settlement, payout, and close', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260824_payment_underwriting_completion_capture_v7');

    const manifest = JSON.parse(
      source('docs/underwriting/payment-underwriting-d6-completion-capture-v7.json')
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D6_COMPLETION_APPROVAL_MANUAL_CAPTURE',
      parentCommit: '9ba77a24ec23a5de8c9193655894d25b4e67a9c0',
      acceptedDependencyCommit: '9ba77a24ec23a5de8c9193655894d25b4e67a9c0',
      acceptedDependencyTree: '80b67e44db9d159dfa96d4b6303448e98cb3cb4f',
      migration: '20260824_payment_underwriting_completion_capture_v7',
      migrationSha256: '25d6cb7acb0e529cfb5f43a0b183e94a8bbb758ce4c91dd29ca480b1a195f31a',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
      captureModel: 'POSTER_APPROVED_MANUAL_CAPTURE',
      tests: [
        'backend/tests/unit/payment-underwriting-completion-capture-v7-rejection-contract.test.ts',
        'backend/tests/integration/payment-underwriting-completion-capture-v7.pg.sql',
      ],
    });
    expect(manifest.invariants).toContain(
      'CAPTURE_OPERATION_BINDS_COMPLETION_AMOUNT_AND_INCIDENT_EVIDENCE'
    );
    expect(manifest.deferredDependencies).toEqual([
      'D7_SETTLEMENT_DOUBLE_ENTRY_RECONCILE_CLOSE',
      'D8_VARIANTS',
    ]);
  });
});
