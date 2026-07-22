import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_worker_counter_offer_contract.sql'),
  'utf8',
);
const exclusivityMigration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_worker_counter_offer_exclusivity.sql'),
  'utf8',
);

describe('worker counter offer database contract', () => {
  it('binds immutable counter economics and append-only events', () => {
    expect(migration).toContain('worker_counter_offers');
    expect(migration).toContain('worker_counter_offer_events');
    expect(migration).toContain('worker_counter_offer_events is append-only');
    expect(migration).toContain('HXCO1: worker counter proposal is immutable');
    expect(migration).toContain('proposed_customer_total_cents = proposed_payout_cents + platform_margin_cents');
    expect(migration).toContain('platform_margin_cents * 10000 >= proposed_customer_total_cents * margin_floor_bps');
  });

  it('requires provider-confirmed refund and an unassigned exact replacement', () => {
    expect(migration).toContain("source_escrow.state <> 'REFUNDED'");
    expect(migration).toContain('source_escrow.stripe_refund_id IS NULL');
    expect(migration).toContain('HXCO6: replacement requires cancelled task and provider-confirmed refund');
    expect(migration).toContain('HXCO7: replacement must preserve Poster and remain unassigned');
    expect(migration).toContain('HXCO8: replacement economics or scope drifted from approved counter');
    expect(migration).toContain('counter_replacement_binding_immutable');
  });

  it('allows only one authorized replacement path per source task', () => {
    expect(exclusivityMigration).toContain('worker_counter_offers_one_authorized_replacement');
    expect(exclusivityMigration).toContain("status IN ('APPROVED_REAUTH_REQUIRED', 'MATERIALIZED')");
  });
});
