import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const migration = source(
  'backend/database/migrations/20260721_task_quote_shortlist_messaging_contract.sql',
);
const harness = source(
  'backend/tests/integration/task-quote-shortlist-messaging.pg.sql',
);
const runner = source('backend/src/jobs/engine-automation-migration.ts');

describe('task quote shortlist messaging database contract', () => {
  it('defines one append-preserved active quote grant controlled by the task Poster', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_quote_shortlists');
    expect(migration).toContain("WHERE status='ACTIVE'");
    expect(migration).toContain('quote shortlist history is append-preserved');
    expect(migration).toContain('quote shortlist identity is immutable');
    expect(migration).toContain('only the task Poster can grant quote-chat access');
    expect(migration).toContain('quote chat requires an active provider application');
  });

  it('closes access on application exit or assignment and backstops the exact message pair', () => {
    expect(migration).toContain('close_task_quote_shortlist_on_assignment');
    expect(migration).toContain('close_task_quote_shortlist_on_application_exit');
    expect(migration).toContain("THEN 'CONVERTED' ELSE 'REVOKED'");
    expect(migration).toContain('enforce_task_message_participant_pair');
    expect(migration).toContain('message pair lacks current task authority');
    expect(migration).toContain('BEFORE INSERT ON task_messages');
  });

  it('is ordered into the startup migration runner', () => {
    expect(runner).toContain('TASK_QUOTE_SHORTLIST_MESSAGING_CONTRACT_MIGRATION');
    expect(runner).toContain('20260721_task_quote_shortlist_messaging_contract.sql');
  });

  it('ships an executable adversarial PostgreSQL harness', () => {
    for (const code of ['HXCHAT1', 'HXCHAT2', 'HXCHAT5', 'HXCHAT7', 'HXCHAT8']) {
      expect(harness).toContain(code);
    }
    expect(harness).toContain('second active quote shortlist unexpectedly succeeded');
    expect(harness).toContain('non-shortlisted candidate message unexpectedly succeeded');
    expect(harness).toContain('message after quote revocation unexpectedly succeeded');
    expect(harness).toContain('TASK_QUOTE_SHORTLIST_MESSAGING_DATABASE_CONTRACT_OK');
  });
});
