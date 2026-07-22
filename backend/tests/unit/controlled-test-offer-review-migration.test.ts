import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_offer_review.sql',
), 'utf8');

describe('controlled TEST offer-review migration', () => {
  it('binds authenticated review and acceptance to exact current evidence', () => {
    for (const invariant of [
      'action_type TEXT NOT NULL',
      'offer_decision_id UUID NOT NULL',
      'duration_evidence_id UUID NOT NULL',
      'provider_capability_evidence_id UUID NOT NULL',
      'liquidity_witness_id UUID NOT NULL',
      'review_action_id UUID',
      "environment='CONTROLLED_TEST'",
      'actor_id=action.worker_id',
      'hxos_local_test_offer_action_current',
    ]) expect(migration).toContain(invariant);
  });

  it('requires a complete private-location snapshot and independently gates assignment', () => {
    for (const invariant of [
      'SERVICE_ZONE_RANGE',
      'exactAddressDisclosed',
      'travelTimeDisclosure',
      'durationRangeMinutes',
      'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT',
      'controlled TEST offer snapshot is incomplete',
      'controlled TEST task acceptance lacks current explicit worker acceptance',
      'local TEST offer actions are append-only',
    ]) expect(migration).toContain(invariant);
  });
});
