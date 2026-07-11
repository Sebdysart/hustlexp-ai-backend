import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Schemas } from '../../src/trpc';

const migration = readFileSync(
  new URL('../../database/migrations/20260710_engine_automation_contracts.sql', import.meta.url),
  'utf8'
);

describe('engine automation contract schema', () => {
  it('pins task.create idempotency with a database uniqueness witness', () => {
    expect(migration).toContain('PRIMARY KEY (poster_id, idempotency_key)');
    expect(migration).toContain('request_hash CHAR(64) NOT NULL');
    expect(migration).toContain('task_id UUID NOT NULL UNIQUE');
  });

  it('separates public rough location from exact location and audits release', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rough_location TEXT');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_location_vault');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_location_access_log');
    expect(migration).toContain('UNIQUE (task_id, worker_id)');
    expect(migration).toContain('INSERT INTO task_location_vault (task_id, exact_location)');
    expect(migration).toContain("location = COALESCE(rough_location, 'Location protected until reservation')");
  });

  it('pins one canonical reservation per engine task plus request idempotency', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_reservations');
    expect(migration).toContain('task_id UUID NOT NULL UNIQUE');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_reservation_requests');
    expect(migration).toContain('idempotency_key TEXT PRIMARY KEY');
  });

  it('pins dispatch expiry, refund blockers, and idempotent request evidence', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS dispatch_expires_at TIMESTAMPTZ');
    expect(migration).toContain("refund_state IN ('NOT_REQUIRED', 'PENDING', 'REFUNDED', 'BLOCKED')");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_dispatch_expiry_requests');
    expect(migration).toContain('idx_tasks_dispatch_expiry_due');
  });

  it('separates completion evidence, payout-ready, and money release', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS completion_message_delivered_at TIMESTAMPTZ');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payout_ready_at TIMESTAMPTZ');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_completion_delivery_events');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_unattended_completion_requests');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS engine_automation_events');
  });

  it('accepts the new task.create contract and rejects malformed idempotency keys', () => {
    const valid = Schemas.createTask.safeParse({
      title: 'Yard cleanup',
      description: 'Clear blackberry vines from the back yard.',
      price: 25000,
      location: '123 Main St, Bellevue, WA 98004',
      roughArea: 'Bellevue, WA',
      clientIdempotencyKey: 'quote-accept:abc_123',
      dispatchExpiresAt: '2026-07-11T12:00:00.000Z',
    });
    expect(valid.success).toBe(true);

    const invalid = Schemas.createTask.safeParse({
      title: 'Yard cleanup',
      description: 'Clear blackberry vines from the back yard.',
      price: 25000,
      clientIdempotencyKey: 'bad key with spaces',
    });
    expect(invalid.success).toBe(false);
  });
});
