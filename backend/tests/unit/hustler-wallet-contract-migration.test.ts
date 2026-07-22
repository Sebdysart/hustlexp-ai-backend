import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_hustler_wallet_contract.sql'),
  'utf8',
);
const PROVIDER_EVENT_SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_wallet_provider_event_integrity.sql'),
  'utf8',
);
const PROVIDER_EVENT_REPAIR_SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_wallet_provider_event_integrity_repair.sql'),
  'utf8',
);
const RUNNER = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'),
  'utf8',
);
const DOCKERFILE = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
const PG_HARNESS = readFileSync(
  resolve(process.cwd(), 'backend/tests/integration/hustler-wallet-contract.pg.sql'),
  'utf8',
);

describe('Hustler wallet database contract', () => {
  it('keeps cash-out terms constrained and one active payout per worker', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS worker_cash_out_requests');
    expect(SQL).toContain("method IN ('STANDARD')");
    expect(SQL).toContain('net_cents = amount_cents - fee_cents');
    expect(SQL).toContain('worker_cash_out_one_active_idx');
    expect(SQL).toContain("WHERE state IN ('INITIATING','SUBMITTED','PROVIDER_PROCESSING')");
    expect(SQL).not.toMatch(/account_number|routing_number|bank_token/i);
  });

  it('requires provider evidence and rejects illegal financial transitions', () => {
    expect(SQL).toContain('HXWAL2: immutable cash-out terms cannot change');
    expect(SQL).toContain('HXWAL3: illegal cash-out transition');
    expect(SQL).toContain('HXWAL4: provider payout evidence is required');
    expect(SQL).toContain("OLD.state = 'PAID' AND NEW.state = 'REVERSED'");
    expect(SQL).not.toContain("OLD.state = 'FAILED' AND NEW.state = 'PAID'");
  });

  it('retains provider-reported state and locks event identity before projection changes', () => {
    expect(PROVIDER_EVENT_SQL).toContain('provider_reported_state');
    expect(PROVIDER_EVENT_SQL).toContain("'APPLIED','NO_STATE_CHANGE','IGNORED_STALE'");
    expect(PROVIDER_EVENT_SQL).toContain('HXWAL7: bound provider payout identity cannot change');
    expect(PROVIDER_EVENT_SQL).toContain('HXWAL8: provider event does not reconcile to cash-out request');
    expect(PROVIDER_EVENT_SQL).toContain("source = 'PROVIDER_WEBHOOK'");
    expect(PROVIDER_EVENT_SQL).not.toMatch(/UPDATE worker_cash_out_events/u);
    expect(PROVIDER_EVENT_SQL).toContain('receipt_contract_version SMALLINT NOT NULL DEFAULT 1');
    expect(PROVIDER_EVENT_SQL).toContain('ALTER COLUMN receipt_contract_version SET DEFAULT 2');
    expect(PROVIDER_EVENT_REPAIR_SQL).not.toMatch(/UPDATE worker_cash_out_events/u);
    expect(PROVIDER_EVENT_REPAIR_SQL).toContain('DROP CONSTRAINT IF EXISTS worker_cash_out_provider_event_requires_reported_state');
  });

  it('records an append-only event for every state change', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS worker_cash_out_events');
    expect(SQL).toContain('AFTER INSERT OR UPDATE OF state');
    expect(SQL).toContain('HXWAL6: cash-out events are append-only');
    expect(SQL).toContain('worker_cash_out_events_provider_event_idx');
  });

  it('permits only a complete GDPR unlink while preserving financial evidence', () => {
    expect(SQL).toContain('Sole privacy exception');
    expect(SQL).toContain('NEW.worker_id IS NULL');
    expect(SQL).toContain('NEW.provider_account_id IS NULL');
    expect(SQL).toContain('NEW.provider_destination_id IS NULL');
    expect(SQL).toContain("NEW.destination_last4 = '0000'");
    expect(SQL).toContain("NEW.destination_label = 'Deleted payout destination'");
    expect(SQL).toContain('NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents');
    expect(SQL).toContain('NEW.provider_payout_id IS NOT DISTINCT FROM OLD.provider_payout_id');
    expect(SQL).toContain('anonymize_worker_wallet_on_user_deletion');
    expect(SQL).toContain("NEW.account_status::text = 'DELETED'");
    expect(SQL).toContain('AFTER UPDATE OF account_status ON users');
  });

  it('ships in the required production migration set and image', () => {
    expect(RUNNER).toContain("HUSTLER_WALLET_CONTRACT_MIGRATION = '20260719_hustler_wallet_contract'");
    expect(RUNNER).toContain("fileName: '20260719_hustler_wallet_contract.sql'");
    expect(RUNNER).toContain("fileName: '20260719_wallet_provider_event_integrity.sql'");
    expect(RUNNER).toContain("fileName: '20260719_wallet_provider_event_integrity_repair.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260719_hustler_wallet_contract.sql ./backend/database/migrations/20260719_hustler_wallet_contract.sql',
    );
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260719_wallet_provider_event_integrity.sql ./backend/database/migrations/20260719_wallet_provider_event_integrity.sql',
    );
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260719_wallet_provider_event_integrity_repair.sql ./backend/database/migrations/20260719_wallet_provider_event_integrity_repair.sql',
    );
  });

  it('includes a PostgreSQL transition and privacy harness', () => {
    expect(PG_HARNESS).toContain('HUSTLER_WALLET_DATABASE_CONTRACT_OK');
    expect(PG_HARNESS).toContain('HXWAL2:');
    expect(PG_HARNESS).toContain('HXWAL3:');
    expect(PG_HARNESS).toContain('HXWAL4:');
    expect(PG_HARNESS).toContain('HXWAL6:');
    expect(PG_HARNESS).toContain("ARRAY['INITIATING','SUBMITTED','PROVIDER_PROCESSING','PAID']");
    expect(PG_HARNESS).toContain("UPDATE users SET account_status='DELETED'");
  });
});
