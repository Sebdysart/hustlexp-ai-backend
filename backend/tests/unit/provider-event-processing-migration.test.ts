import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const migration = readFileSync(resolve(
  root,
  'backend/database/migrations/20260919_provider_event_processing_v1.sql',
), 'utf8');
const repository = readFileSync(resolve(
  root,
  'backend/src/services/payment/ProviderEventProcessing.ts',
), 'utf8');
const replayWorker = readFileSync(resolve(
  root,
  'backend/src/jobs/provider-event-replay-worker.ts',
), 'utf8');
const productionWorkerBootstrap = readFileSync(resolve(
  root,
  'backend/src/jobs/workers.ts',
), 'utf8');

describe('provider-event processing migration and scheduling contract', () => {
  it('separates mutable lease coordination from append-only attempt and outcome evidence', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.provider_event_processing_state');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.provider_event_processing_attempts');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.provider_event_processing_outcomes');
    expect(migration).toContain('provider_event_processing_attempt_no_update_delete');
    expect(migration).toContain('provider_event_processing_outcome_no_update_delete');
    expect(migration).toContain('provider event processing evidence is append-only');
    expect(migration).toContain("'SUCCEEDED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED', 'LEASE_EXPIRED'");
  });

  it('binds each attempt to one fake provider event identity and a bounded lease', () => {
    expect(migration).toContain("inbox_provider_kind <> 'FAKE'");
    expect(migration).toContain("'provider-event:' || encode(");
    expect(migration).toContain("|| decode('00', 'hex')");
    expect(migration).toContain("lease_expires_at <= leased_at + INTERVAL '5 minutes'");
    expect(migration).toContain('normalization idempotency identity mismatch');
    expect(migration).toContain('provider_event_processing_attempt_lease_identity_uniq');
    expect(migration).toContain('active_lease_token IS DISTINCT FROM NEW.lease_token');
    expect(migration).toContain('FOR UPDATE OF processing');
    expect(migration).toContain("processing_state <> 'LEASED'");
    expect(migration).toContain('= 0');
    expect(repository).toContain('FOR UPDATE OF processing SKIP LOCKED');
    expect(repository).toContain("observation.provider_kind='FAKE'");
    expect(repository).toContain("receipt.authentication_status='VERIFIED'");
  });

  it('keeps replay opt-in, fake-gated, and absent from production worker scheduling', () => {
    expect(replayWorker).toContain("assertNonproductionFakeFinanceAuthorized({ component: 'worker' })");
    expect(replayWorker).toContain('assertWebhookOperationBoundary');
    expect(replayWorker).toContain('createUniversalV1FakeFinancialApplicationService');
    expect(productionWorkerBootstrap).not.toContain('provider-event-replay-worker');
    expect(migration).not.toMatch(/stripe|payment_intent|live provider/iu);
  });

  it('rejects every non-expiry outcome after its processing lease has expired', () => {
    expect(migration).toContain("NEW.outcome_kind <> 'LEASE_EXPIRED'");
    expect(migration).toContain('expired lease cannot record a processing outcome');
    expect(migration).toContain("NEW.recorded_at := clock_timestamp()");
    expect(migration).toContain("NEW.leased_at := clock_timestamp()");
  });
});
