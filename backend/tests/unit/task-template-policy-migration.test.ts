import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_task_template_policy_contract.sql'),
  'utf8',
);

describe('task template policy migration', () => {
  it('adds the authoritative mutual-consent requirement', () => {
    expect(sql).toContain('mutual_consent_required BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sql).toContain('NEW.mutual_consent_required AND NOT NEW.mutual_consent_accepted');
    expect(sql).toContain('HXTP3');
  });

  it('quarantines legacy tasks from acceptance without a v2 policy witness', () => {
    expect(sql).toContain("NOT LIKE 'task-template-v2:%'");
    expect(sql).toContain('HXTP2');
  });

  it('makes the content-derived policy immutable after insertion', () => {
    for (const column of [
      'risk_level',
      'trust_tier_required',
      'completion_criteria',
      'content_release',
      'mutual_consent_required',
      'cancellation_policy_version',
    ]) {
      expect(sql).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(sql).toContain('HXTP1');
  });
});
