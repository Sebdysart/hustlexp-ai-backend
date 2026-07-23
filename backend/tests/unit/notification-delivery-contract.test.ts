import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_notification_delivery_contract.sql');
const REPAIR = read(
  'backend/database/migrations/20260720_notification_delivery_contract_repair.sql'
);
const FOCUS = read('backend/database/migrations/20260720_notification_focus_suppression.sql');
const CONSTITUTIONAL = read('backend/database/constitutional-schema.sql');
const LAUNCH = read('backend/database/launch-schema.sql');
const RUNNER = read('backend/src/jobs/engine-automation-migration.ts');
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
      '/app/backend/database/migrations/20260720_notification_delivery_contract.sql'
    );
    expect(RUNNER).toMatch(
      /NOTIFICATION_DELIVERY_CONTRACT_REPAIR_MIGRATION\s*=\s*'20260720_notification_delivery_contract_repair'/
    );
    expect(RUNNER).toContain("fileName: '20260720_notification_delivery_contract_repair.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_notification_delivery_contract_repair.sql'
    );
    expect(REPAIR).toMatch(/alter table public\.email_outbox[\s\S]*updated_at/i);
    expect(REPAIR).toMatch(/create index if not exists idx_sms_outbox_status/i);
    expect(REPAIR).toContain("WHERE status IN ('pending', 'failed')");
    expect(RUNNER).toMatch(
      /NOTIFICATION_FOCUS_SUPPRESSION_MIGRATION\s*=\s*'20260720_notification_focus_suppression'/
    );
    expect(RUNNER).toContain("fileName: '20260720_notification_focus_suppression.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_notification_focus_suppression.sql'
    );
    for (const token of [
      'focus_task_id',
      'focus_deferred_at',
      'focus_released_at',
      'deferred_focus',
      'idx_notifications_focus_deferred',
    ])
      expect(FOCUS).toContain(token);
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
    ]) {
      expect(baseline).toContain(token);
    }
    expect(baseline).toContain("'pending', 'enqueued', 'processing', 'processed', 'failed'");
  });
});
