import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const predecessorPath =
  'backend/database/migrations/20261006_stage1_legacy_authority_containment_v1.sql';
const migrationPath =
  'backend/database/migrations/20261007_subscription_cancellation_recovery_v1.sql';
const predecessor = read(predecessorPath);
const migration = read(migrationPath);

describe('subscription cancellation recovery migration', () => {
  it('is append-only ordinal 141 after the byte-frozen migration 140', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[139]).toEqual({
      name: '20261006_stage1_legacy_authority_containment_v1',
      fileName: '20261006_stage1_legacy_authority_containment_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[140]).toEqual({
      name: '20261007_subscription_cancellation_recovery_v1',
      fileName: '20261007_subscription_cancellation_recovery_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES.slice(141)).toEqual([
      {
        name: '20261008_universal_v1_work_order_task_state_containment_v1',
        fileName: '20261008_universal_v1_work_order_task_state_containment_v1.sql',
      },
      {
        name: '20261009_universal_v1_standardized_quote_readiness_v1',
        fileName: '20261009_universal_v1_standardized_quote_readiness_v1.sql',
      },
      {
        name: '20261010_universal_v1_financial_security_event_expiry_v1',
        fileName: '20261010_universal_v1_financial_security_event_expiry_v1.sql',
      },
      {
        name: '20261012_universal_v1_work_order_command_authority_v2',
        fileName: '20261012_universal_v1_work_order_command_authority_v2.sql',
      },
      {
        name: '20261014_universal_v1_work_order_command_ports_v1',
        fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
      },
    ]);
    expect(createHash('sha256').update(predecessor).digest('hex')).toBe(
      '5cc6f5710696048b98c97ea06993a56aefaf711bac7a04dd973059f957d4eb63'
    );
  });

  it('records exact provider reference, operation state, and retryable failure evidence', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS subscription_cancellation_events_v1');
    expect(migration).toMatch(/event_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE/);
    expect(migration).toMatch(/operation_id UUID NOT NULL/);
    expect(migration).toMatch(/user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/);
    expect(migration).toMatch(/provider_kind TEXT NOT NULL CHECK \(provider_kind = 'stripe'\)/);
    expect(migration).toMatch(
      /external_subscription_id TEXT NOT NULL CHECK \(length\(btrim\(external_subscription_id\)\) > 0\)/
    );
    expect(migration).toContain("'CANCELLATION_UNCERTAIN'");
    expect(migration).toContain(
      "status IN ('PROVIDER_FAILED', 'CANCELLATION_UNCERTAIN') AND error_code IS NOT NULL"
    );
    expect(migration).toContain(
      "status NOT IN ('PROVIDER_FAILED', 'CANCELLATION_UNCERTAIN') AND error_code IS NULL"
    );
    expect(migration).toContain('subscription_cancellation_events_one_pending_idx');
    expect(migration).toContain("WHERE status = 'CANCELLATION_PENDING'");
    expect(migration).toContain('subscription_cancellation_events_one_confirmed_idx');
    expect(migration).toContain("WHERE status = 'CANCELLED_CONFIRMED'");
    expect(migration).toContain(
      '(user_id, provider_kind, external_subscription_id, event_sequence DESC)'
    );
  });

  it('makes cancellation evidence append-only, including truncate containment', () => {
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(migration).not.toMatch(/\bCASCADE\b/iu);
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON subscription_cancellation_events_v1');
    expect(migration).toContain('EXECUTE FUNCTION prevent_append_only_row_mutation()');
    expect(migration).toContain('BEFORE TRUNCATE ON subscription_cancellation_events_v1');
    expect(migration).toContain('EXECUTE FUNCTION prevent_append_only_truncate()');
  });
});
