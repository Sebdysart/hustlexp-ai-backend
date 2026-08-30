import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_notification_delivery_contract.sql');
const REPAIR = read(
  'backend/database/migrations/20260720_notification_delivery_contract_repair.sql'
);
const FOCUS = read('backend/database/migrations/20260720_notification_focus_suppression.sql');
const PROVIDER_NEUTRAL = read(
  'backend/database/migrations/20260831_provider_neutral_outbound_communication.sql'
);
const LEAD_INGRESS = read(
  'backend/database/migrations/20260901_universal_v1_lead_ingress_port.sql'
);
const IN_FLIGHT = read('backend/database/migrations/20260914_notification_provider_in_flight.sql');
const CONSTITUTIONAL = read('backend/database/constitutional-schema.sql');
const LAUNCH = read('backend/database/launch-schema.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');

describe('HX/OS notification delivery database contract', () => {
  it('persists class, object, dedupe, supersession, deferment, and failure truth', () => {
    for (const column of [
      'notification_class',
      'object_type',
      'object_id',
      'dedupe_key',
      'supersession_key',
      'superseded_at',
      'superseded_by_notification_id',
      'available_at',
      'delivery_state',
      'delivery_attempts',
      'terminal_failure_at',
      'terminal_failure_reason',
    ]) {
      expect(MIGRATION).toContain(column);
    }
    expect(MIGRATION).toContain('idx_notifications_dedupe_key');
    expect(MIGRATION).toContain('cancelled_superseded');
    expect(MIGRATION).toContain('operator_exception');
  });

  it('makes every external outbox deferable, retry-bounded, and notification-linked', () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.device_tokens/i);
    expect(MIGRATION).toMatch(/create table if not exists public\.sms_outbox/i);
    expect(MIGRATION).toMatch(/alter table public\.outbox_events[\s\S]*available_at/i);
    expect(MIGRATION).toMatch(/alter table public\.email_outbox[\s\S]*notification_id/i);
    expect(MIGRATION).toMatch(/alter table public\.sms_outbox[\s\S]*notification_id/i);
    expect(MIGRATION).toContain('max_retries');
    expect(MIGRATION).toContain('provider_status');
    expect(MIGRATION).toContain('delivered_at');
    expect(MIGRATION).toContain('sms_outbox_status_chk');
    expect(MIGRATION).toContain("'pending','sending','sent','failed','suppressed'");
  });

  it('ships the delivery, repair, and Focus contracts in the startup chain', () => {
    expect(RUNNER).toMatch(
      /NOTIFICATION_DELIVERY_CONTRACT_MIGRATION\s*=\s*'20260720_notification_delivery_contract'/
    );
    expect(RUNNER).toContain("fileName: '20260720_notification_delivery_contract.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations ./backend/database/migrations'
    );
    expect(RUNNER).toMatch(
      /NOTIFICATION_DELIVERY_CONTRACT_REPAIR_MIGRATION\s*=\s*'20260720_notification_delivery_contract_repair'/
    );
    expect(RUNNER).toContain("fileName: '20260720_notification_delivery_contract_repair.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations ./backend/database/migrations'
    );
    expect(REPAIR).toMatch(/alter table public\.email_outbox[\s\S]*updated_at/i);
    expect(REPAIR).toMatch(/create index if not exists idx_sms_outbox_status/i);
    expect(REPAIR).toContain("WHERE status IN ('pending', 'failed')");
    expect(RUNNER).toMatch(
      /NOTIFICATION_FOCUS_SUPPRESSION_MIGRATION\s*=\s*'20260720_notification_focus_suppression'/
    );
    expect(RUNNER).toContain("fileName: '20260720_notification_focus_suppression.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations ./backend/database/migrations'
    );
    for (const token of [
      'focus_task_id',
      'focus_deferred_at',
      'focus_released_at',
      'deferred_focus',
      'idx_notifications_focus_deferred',
    ])
      expect(FOCUS).toContain(token);
    expect(RUNNER).toContain("fileName: '20260914_notification_provider_in_flight.sql'");
    expect(IN_FLIGHT).toContain("'provider_in_flight'");
    expect(IN_FLIGHT).toContain('not provider acceptance');
  });

  it.each([
    ['constitutional baseline', CONSTITUTIONAL],
    ['launch baseline', LAUNCH],
  ])('keeps the %s converged with the notification delivery contract', (_label, baseline) => {
    for (const token of [
      'notification_class',
      'dedupe_key',
      'supersession_key',
      'quiet_hours_timezone',
      'outbox_events_status_chk',
      'available_at',
      'email_outbox_notification_fk',
      'sms_outbox_status_chk',
      'notification_deliveries',
      'idx_notification_deliveries_terminal',
      'device_tokens',
      'deferred_focus',
      'focus_task_id',
      'idx_notifications_focus_deferred',
      'provider_in_flight',
    ]) {
      expect(baseline).toContain(token);
    }
    expect(baseline).toContain("'pending', 'enqueued', 'processing', 'processed', 'failed'");

    const smsOutbox = baseline.match(
      /CREATE TABLE IF NOT EXISTS sms_outbox\s*\(([\s\S]*?)\n\);/i,
    )?.[1];
    expect(smsOutbox).toBeDefined();
    expect(smsOutbox).toMatch(/\bprovider_name\s+TEXT\b/i);
    expect(smsOutbox).toMatch(/\bprovider_message_id\s+TEXT\b/i);
    expect(baseline).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_sms_outbox_provider_receipt\s+ON sms_outbox\(provider_name, provider_message_id\)\s+WHERE provider_message_id IS NOT NULL/i,
    );

    const emailOutbox = baseline.match(
      /CREATE TABLE IF NOT EXISTS email_outbox\s*\(([\s\S]*?)\n\);/i,
    )?.[1];
    expect(emailOutbox).toBeDefined();
    expect(emailOutbox).toMatch(/\buser_id\s+UUID\s+REFERENCES users\(id\)/i);
    expect(emailOutbox).not.toMatch(/\buser_id\s+UUID\s+NOT NULL/i);
    expect(emailOutbox).toMatch(/\blead_id\s+UUID\s+REFERENCES leads\(id\)/i);
    expect(emailOutbox).toMatch(
      /CONSTRAINT email_outbox_exactly_one_owner CHECK \(num_nonnulls\(user_id, lead_id\) = 1\)/i,
    );
    for (const token of [
      'CREATE TABLE IF NOT EXISTS leads',
      'leads_ingress_request_hash_shape',
      'leads_ingress_contract_version_shape',
      'idx_leads_ingress_rate_window',
      'idx_email_outbox_lead',
      'idx_email_outbox_provider_receipt',
    ]) {
      expect(baseline).toContain(token);
    }
  });

  it('keeps upgraded and clean SMS receipt authority on the same provider-neutral columns', () => {
    expect(PROVIDER_NEUTRAL).toMatch(
      /ALTER TABLE public\.sms_outbox[\s\S]*ADD COLUMN IF NOT EXISTS provider_name TEXT,[\s\S]*ADD COLUMN IF NOT EXISTS provider_message_id TEXT/i,
    );
    expect(PROVIDER_NEUTRAL).toContain(
      'provider_message_id = COALESCE(provider_message_id, twilio_sid)'
    );
    expect(PROVIDER_NEUTRAL).toContain('idx_sms_outbox_provider_receipt');
  });

  it('keeps upgraded and clean anonymous-lead email ownership equivalent', () => {
    expect(LEAD_INGRESS).toContain('ALTER COLUMN user_id DROP NOT NULL');
    expect(LEAD_INGRESS).toContain('ADD COLUMN IF NOT EXISTS lead_id UUID');
    expect(LEAD_INGRESS).toContain('email_outbox_exactly_one_owner');
    expect(LEAD_INGRESS).toContain('idx_email_outbox_lead');
    expect(LEAD_INGRESS).toContain('idx_leads_ingress_rate_window');
  });
});
