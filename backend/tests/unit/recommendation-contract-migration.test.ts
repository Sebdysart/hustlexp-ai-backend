import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_recommendation_contract.sql'),
  'utf8',
);
const MIGRATION_RUNNER = [
  readFileSync(resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'), 'utf8'),
  readFileSync(
    resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
    'utf8',
  ),
].join('\n');
const DOCKERFILE = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
const TASK_COMPLETION = readFileSync(
  resolve(process.cwd(), 'backend/src/services/TaskCompletionService.ts'),
  'utf8',
);
const POSTGRES_HARNESS = readFileSync(
  resolve(process.cwd(), 'backend/tests/integration/recommendation-contract.pg.sql'),
  'utf8',
);

describe('authoritative Recommendation database contract', () => {
  it('stores immutable provenance, evidence classes, uncertainty, controls, and retention', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS recommendations');
    for (const field of [
      'recipient_user_id', 'subject_type', 'subject_id', 'recommendation_class',
      'source_type', 'recommendation_text', 'reason', 'evidence_classes',
      'expected_benefit', 'downside', 'confidence_band', 'model_version',
      'policy_version', 'scope_affected', 'user_controls', 'request_hash',
      'idempotency_key', 'retention_class', 'purge_after',
    ]) expect(SQL).toContain(field);
    expect(SQL).toContain('recommendations_immutable');
    expect(SQL).toContain('prevent_recommendation_mutation');
  });

  it('keeps interaction and realized outcome evidence append-only and replay-safe', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS recommendation_events');
    expect(SQL).toContain("'DISPLAYED','OPENED','EDITED','DISMISSED','SNOOZED','IGNORED','OVERRIDDEN','APPEALED'");
    expect(SQL).toContain('ranking_penalty NUMERIC NOT NULL DEFAULT 0 CHECK (ranking_penalty = 0)');
    expect(SQL).toContain('UNIQUE (recommendation_id, idempotency_key)');
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS recommendation_outcomes');
    expect(SQL).toContain('UNIQUE (recommendation_id, outcome_type, source_object_id)');
    expect(SQL).toContain('recommendation_events_immutable');
    expect(SQL).toContain('recommendation_outcomes_immutable');
  });

  it('records truthful task settlement outcomes at the database release boundary', () => {
    expect(SQL).toContain('record_task_recommendation_settlement_outcome');
    expect(SQL).toContain('AFTER UPDATE OF state ON escrows');
    expect(SQL).toContain("WHEN NEW.stripe_transfer_id IS NOT NULL THEN 'CONNECTED_BALANCE'");
    expect(SQL).toContain("ELSE 'RELEASE_STATE_ONLY'");
    expect(SQL).toContain("'bankPayoutConfirmed', FALSE");
    expect(SQL).toContain("'TASK_SETTLED'");
    expect(POSTGRES_HARNESS).toContain('RECOMMENDATION_DATABASE_CONTRACT_OK');
    expect(POSTGRES_HARNESS).toContain('CONNECTED_BALANCE');
    expect(POSTGRES_HARNESS).toContain('RELEASE_STATE_ONLY');
    expect(POSTGRES_HARNESS).toContain('bankPayoutConfirmed');
  });

  it('rejects raw evidence payloads and autonomous execution authority', () => {
    expect(SQL).toContain("jsonb_typeof(evidence_classes) = 'array'");
    expect(SQL).toContain("autonomy_level = 'RECOMMEND_ONLY'");
    expect(SQL).toContain("source_type IN ('AI','DETERMINISTIC','POLICY')");
    expect(SQL).toContain("confidence_band IN ('STRONG_SIGNAL','LIKELY','SUGGESTION','UNKNOWN')");
  });

  it('packages the Recommendation contract in the production migration runtime', () => {
    expect(MIGRATION_RUNNER).toContain("RECOMMENDATION_CONTRACT_MIGRATION = '20260719_recommendation_contract'");
    expect(MIGRATION_RUNNER).toContain("fileName: '20260719_recommendation_contract.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260719_recommendation_contract.sql ./backend/database/migrations/20260719_recommendation_contract.sql',
    );
  });

  it('records realized recommendation outcomes in the authoritative task-completion transaction', () => {
    expect(TASK_COMPLETION).toContain('RecommendationService.recordTaskOutcome(query');
    expect(TASK_COMPLETION).toContain("outcomeType: 'TASK_COMPLETED'");
    expect(TASK_COMPLETION).toContain("taskState: 'COMPLETED'");
    expect(TASK_COMPLETION).toContain('payoutReady: true');
  });
});
