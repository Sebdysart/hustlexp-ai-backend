import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const path = resolve(
  process.cwd(),
  'backend/database/migrations/20261004_universal_v1_completion_notice_dispatch_v1.sql'
);
const sql = readFileSync(path, 'utf8');

describe('Universal V1 completion-notice dispatch migration', () => {
  it('preserves the exact append-only ordinal 138 registry identity', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(140);
    expect(REQUIRED_MIGRATION_FILES.at(-3)).toEqual({
      name: '20261004_universal_v1_completion_notice_dispatch_v1',
      fileName: '20261004_universal_v1_completion_notice_dispatch_v1.sql',
    });
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
    expect(
      analyzeMigrationFile(path, sql).filter((issue) => issue.severity === 'BLOCKER')
    ).toEqual([]);
  });

  it('binds one immutable request to one EMAIL row and matching outbox event', () => {
    for (const fragment of [
      'CREATE TABLE IF NOT EXISTS public.task_completion_notice_requests',
      'submitted_completion_fact_id UUID NOT NULL UNIQUE',
      'completion_execution_fact_id UUID NOT NULL UNIQUE',
      "channel TEXT NOT NULL CHECK (channel = 'EMAIL')",
      "provider_kind TEXT NOT NULL CHECK (provider_kind = 'SYNTHETIC_SINK')",
      'task_completion_notice_request_id UUID',
      'provider_receipt_at TIMESTAMPTZ',
      'task_completion_notice_dispatch_exact_binding',
      'matching_emails <> 1 OR matching_events <> 1',
      "'email.send_requested'",
      "'user_notifications'",
      'task_completion_notice_requests_immutable',
      'task_completion_notice_requests_no_truncate',
      'email_outbox_completion_notice_no_truncate',
      'outbox_events_completion_notice_no_truncate',
      'HXUV1-NOTICE-19: protected completion notice outbox identity cannot be changed',
      'HXUV1-NOTICE-21: completion notice outbox may close only after a valid terminal delivery outcome',
      'HXUV1-NOTICE-22: notice dispatch must commit in its exact fresh pending state',
      'HXUV1-NOTICE-23: provider I/O marker requires the exact active completion dispatch',
      'HXUV1-NOTICE-24: completion transport identity must not predate its request',
      'HXUV1-NOTICE-25: completion notice email state transition is not permitted',
      'HXUV1-NOTICE-26: completion notice terminal audit state is immutable',
      'HXUV1-NOTICE-27: processed completion notice outbox state is immutable',
      'initial_email.max_attempts IS DISTINCT FROM 3',
      'initial_email.available_at > clock_timestamp()',
      'initial_event.available_at > clock_timestamp()',
      'COALESCE(recipient.do_not_email, FALSE) IS FALSE',
      'HXUV1-NOTICE-UPGRADE-1: partial legacy completion delivery audit rows',
      "OLD.status = 'provider_outcome_unknown'",
      "NEW.status = 'sent'",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('derives exactly one synthetic delivery fact from a persisted smtp_sink receipt', () => {
    for (const fragment of [
      'materialize_universal_v1_completion_notice_delivery',
      "email_record.provider_name IS DISTINCT FROM 'smtp_sink'",
      "'smtp_sink:' || email_record.provider_msg_id",
      "'SYNTHETIC_SINK'",
      "'hustlexp.synthetic-communications-sink.v1:'",
      'task_completion_delivery_notice_request_unique',
      'universal_v1_completion_notice_receipt_sha256',
      'task_record.universal_payment_posture',
      "task_record.worker_id IS NOT NULL",
      'email_record.provider_io_started_at IS NULL',
      'email_record.notification_provider_attempt_id IS NULL',
      'email_record.provider_receipt_at < email_record.provider_io_started_at',
      'HXUV1-DELIVERY-6: request-bound completion notices reject legacy unbound receipt writers',
      'HXUV1-NOTICE-20: approval requires the exact request-bound completion delivery fact',
      "hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)",
      'expected_provider_delivery_id',
      'request_record.id,\n    expected_provider_delivery_id,',
      'task_completion_delivery_universal_v1_shape_check',
      'provider_service_identity IS NOT NULL',
      'NEW.provider_service_identity IS DISTINCT FROM',
      'NEW.policy_version IS DISTINCT FROM',
      'NEW.provider_callback_at IS NULL',
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).not.toMatch(/\bprovider_delivery_id\s*:=/u);
    expect(sql).not.toMatch(/INSERT INTO public\.(?:task_financial|escrow|payment|payout)/iu);
    expect(sql).not.toMatch(/UPDATE public\.tasks[\s\S]*worker_id/iu);
  });

  it('pins search paths and removes PUBLIC execute authority from every new function', () => {
    const functions = sql.match(/CREATE OR REPLACE FUNCTION/gu) ?? [];
    const searchPaths = sql.match(/SET search_path = pg_catalog, public/gu) ?? [];
    expect(functions).toHaveLength(14);
    expect(searchPaths).toHaveLength(functions.length);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.materialize_universal_v1_completion_notice_delivery(UUID)'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_delivery_receipt()'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.lock_universal_v1_fulfillment_execution_insert()'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.lock_universal_v1_fulfillment_completion_insert()'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_approval_binding()'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.materialize_universal_v1_completion_notice_delivery(UUID)'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.universal_v1_completion_notice_request_sha256('
    );
    expect(sql).toContain('REVOKE ALL ON TABLE public.task_completion_notice_requests FROM PUBLIC');
  });
});
