import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260915_ai_spend_attempt_ledger.sql'),
  'utf8',
);
const registry = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
  'utf8',
);
const constitutional = readFileSync(resolve(process.cwd(), 'backend/database/constitutional-schema.sql'), 'utf8');
const launch = readFileSync(resolve(process.cwd(), 'backend/database/launch-schema.sql'), 'utf8');

describe('AI spend attempt ledger migration', () => {
  it('is registered immediately after the provider-in-flight migration', () => {
    expect(registry).toContain("name: '20260915_ai_spend_attempt_ledger'");
    expect(registry.indexOf('20260915_ai_spend_attempt_ledger')).toBeGreaterThan(
      registry.indexOf('20260914_notification_provider_in_flight'),
    );
  });

  it('requires one pre-I/O reservation and at most one append-only terminal fact', () => {
    for (const token of [
      'ai_spend_attempt_events',
      "transition IN ('RESERVED','UNKNOWN','SETTLED','RELEASED')",
      'ai_spend_attempt_one_terminal_uniq',
      'requires its exact RESERVED predecessor',
      'differs from RESERVED predecessor',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'AI spend attempt evidence is append-only',
    ]) expect(sql).toContain(token);
  });

  it('stores only a hashed subject and forbids raw prompt/output columns', () => {
    expect(sql).toContain('subject_ref_hash CHAR(64)');
    expect(sql).not.toMatch(/\b(?:raw_prompt|prompt_text|provider_output|response_body)\b/iu);
  });

  it('keeps both canonical schema baselines aligned with the migration authority', () => {
    for (const baseline of [constitutional, launch]) {
      for (const token of [
        'CREATE TABLE IF NOT EXISTS public.ai_spend_attempt_events',
        'ai_spend_attempt_one_terminal_uniq',
        'enforce_ai_spend_attempt_event_insert',
        'reject_ai_spend_attempt_event_mutation',
        'ai_spend_attempt_events_no_truncate',
        'UTC epoch-day selected atomically by Redis TIME',
      ]) expect(baseline).toContain(token);
    }
  });
});
