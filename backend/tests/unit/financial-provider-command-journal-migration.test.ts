import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260917_financial_provider_command_journal_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8',
);
const constitutional = readFileSync(
  resolve(process.cwd(), 'backend/database/constitutional-schema.sql'),
  'utf8',
);
const launch = readFileSync(resolve(process.cwd(), 'backend/database/launch-schema.sql'), 'utf8');

describe('financial provider command journal migration', () => {
  it('is the exact ordered successor to the provider-event inbox', () => {
    const inboxIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260916_provider_event_inbox_v1',
    );
    const commandJournalIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260917_financial_provider_command_journal_v1',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(inboxIndex).toBeGreaterThanOrEqual(0);
    expect(commandJournalIndex).toBe(inboxIndex + 1);
    expect(REQUIRED_MIGRATION_FILES[commandJournalIndex]).toEqual({
      name: '20260917_financial_provider_command_journal_v1',
      fileName,
    });
  });

  it('binds one immutable request to an operation version and idempotency key', () => {
    for (const token of [
      'financial_provider_command_journal',
      "command_state = 'REQUESTED'",
      'provider_expected_version',
      'request_sha256',
      'command_identity_sha256',
      'financial_provider_command_idempotency_uniq',
      'financial_provider_command_operation_version_uniq',
      'UNIQUE (provider_kind, operation_kind, operation_id, provider_expected_version)',
    ])
      expect(migration).toContain(token);
  });

  it('stores only fixed safe evidence and no raw provider request material', () => {
    for (const token of [
      'task_draft_id UUID',
      'task_id UUID',
      'work_order_id UUID',
      'related_operation_id UUID',
      'recorded_actor_id UUID',
      'release_manifest_digest TEXT',
    ])
      expect(migration).toContain(token);
    expect(migration).not.toMatch(/\brequest_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bpayment_method_reference\s+/iu);
    expect(migration).not.toMatch(/\bprovider_account_reference\s+/iu);
  });

  it('denies mutation and keeps approved-provider evidence non-authorizing but fail-closed', () => {
    for (const token of [
      'financial_provider_command_approved_provider_evidence_chk',
      "release_authentication_status = 'VERIFIED'",
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'financial provider command evidence is append-only',
      'it grants no provider, payment, deployment, or production',
    ])
      expect(migration).toContain(token);
  });

  it('keeps both clean-install schema baselines aligned', () => {
    for (const baseline of [constitutional, launch]) {
      expect(baseline).toContain(migration.trim());
      expect(baseline).not.toMatch(/^\+$/mu);
      for (const token of [
        'CREATE TABLE IF NOT EXISTS public.financial_provider_command_journal',
        'financial_provider_command_operation_version_uniq',
        'financial_provider_command_approved_provider_evidence_chk',
        'financial_provider_command_no_update_delete',
        'financial_provider_command_no_truncate',
        'reject_financial_provider_command_mutation',
      ]) {
        expect(baseline).toContain(token);
      }
    }
  });
});
