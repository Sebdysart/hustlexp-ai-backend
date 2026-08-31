import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const fileName = '20260916_provider_event_inbox_v1.sql';
const migrationPath = resolve(process.cwd(), 'backend/database/migrations', fileName);
const sql = readFileSync(migrationPath, 'utf8');
const constitutional = readFileSync(
  resolve(process.cwd(), 'backend/database/constitutional-schema.sql'),
  'utf8',
);
const launch = readFileSync(resolve(process.cwd(), 'backend/database/launch-schema.sql'), 'utf8');

describe('provider-event inbox migration', () => {
  it('is registered immediately after the durable AI-spend attempt migration', () => {
    const predecessor = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260915_ai_spend_attempt_ledger',
    );
    const inbox = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260916_provider_event_inbox_v1',
    );
    expect(predecessor).toBeGreaterThanOrEqual(0);
    expect(inbox).toBe(predecessor + 1);
    expect(REQUIRED_MIGRATION_FILES[inbox]).toEqual({
      name: '20260916_provider_event_inbox_v1',
      fileName,
    });
  });

  it('separates one provider observation from every authenticated delivery receipt', () => {
    for (const token of [
      'provider_event_inbox_observations',
      'provider_event_inbox_receipts',
      'UNIQUE (provider_kind, provider_event_reference)',
      'UNIQUE (ingress_idempotency_key)',
      "authentication_status = 'VERIFIED'",
      "raw_payload_sha256 = encode(digest(raw_payload, 'sha256'), 'hex')",
      'ON DELETE RESTRICT',
    ]) {
      expect(sql).toContain(token);
    }
    expect(sql).not.toContain("authentication_status TEXT NOT NULL DEFAULT 'VERIFIED'");
  });

  it('makes both facts append-only, including truncate, and grants no money capability', () => {
    for (const token of [
      'provider_event_inbox_observations_no_update_delete',
      'provider_event_inbox_observations_no_truncate',
      'provider_event_inbox_receipts_no_update_delete',
      'provider_event_inbox_receipts_no_truncate',
      'provider event inbox evidence is append-only',
      'It grants no financial or lifecycle authority',
      'REVOKE ALL ON TABLE',
    ]) {
      expect(sql).toContain(token);
    }
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+(?:public\.)?(?:tasks|escrows|task_financial)/iu);
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
    expect(
      analyzeMigrationFile(migrationPath, sql).filter((issue) => issue.severity === 'BLOCKER'),
    ).toEqual([]);
  });

  it('keeps both clean-install schema baselines aligned', () => {
    for (const baseline of [constitutional, launch]) {
      for (const token of [
        'CREATE TABLE IF NOT EXISTS public.provider_event_inbox_observations',
        'provider_event_inbox_provider_event_uniq',
        'CREATE TABLE IF NOT EXISTS public.provider_event_inbox_receipts',
        'provider_event_inbox_ingress_idempotency_uniq',
        'reject_provider_event_inbox_mutation',
      ]) {
        expect(baseline).toContain(token);
      }
    }
  });
});
