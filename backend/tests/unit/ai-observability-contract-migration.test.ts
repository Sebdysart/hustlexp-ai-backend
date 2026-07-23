import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const MIGRATION = read('backend/database/migrations/20260721_ai_observability_contract.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');

describe('HX/OS AI observability contract migration', () => {
  it('creates immutable privacy-safe event, outcome, and purpose-access evidence', () => {
    for (const table of [
      'ai_observation_events',
      'ai_observation_outcomes',
      'ai_observation_access_log',
    ]) {
      expect(MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(MIGRATION).toContain('output_hash CHAR(64)');
    expect(MIGRATION).not.toContain('raw_prompt ');
    expect(MIGRATION).not.toContain('prompt_text ');
    expect(MIGRATION).not.toContain('raw_output ');
    expect(MIGRATION).not.toContain('output_text ');
    expect(MIGRATION).toContain('controls @> \'{"why":true,"autoExecute":false,"reversible":true}\'::JSONB');
    expect(MIGRATION).toContain('CREATE TRIGGER ai_observation_events_immutable');
    expect(MIGRATION).toContain('CREATE TRIGGER ai_observation_outcomes_immutable');
    expect(MIGRATION).toContain('CREATE TRIGGER ai_observation_access_log_immutable');
    expect(MIGRATION).toContain('HXAI1: AI observability evidence is append-only');
  });

  it('binds an applied scope proposal to the same Poster without giving it execution authority', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS ai_scope_observation_id UUID');
    expect(MIGRATION).toContain("observation.surface_id = 'AI-SCOPER-PROPOSAL'");
    expect(MIGRATION).toContain('observation.actor_user_id = NEW.poster_id');
    expect(MIGRATION).toContain("observation.execution_result IN ('GENERATED','CACHED')");
    expect(MIGRATION).toContain('"apply":true,"edit":true,"autoExecute":false');
    expect(MIGRATION).toContain('HXAI2: task scope observation is missing, foreign, or non-applicable');
    expect(MIGRATION).toContain("'proposalAuthorizedState', FALSE");
    expect(MIGRATION).toContain("'executablePolicyRevalidated', TRUE");
    expect(MIGRATION).toContain('CREATE TRIGGER tasks_record_ai_scope_outcome');
  });

  it('links AI recommendations and their user or task outcomes to the exact observation', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS ai_observation_id UUID');
    expect(MIGRATION).toContain("observation.surface_id = 'AI-TASK-SUGGESTION-PROPOSAL'");
    expect(MIGRATION).toContain('observation.actor_user_id = NEW.recipient_user_id');
    expect(MIGRATION).toContain('HXAI3: AI recommendation observation is missing, foreign, or non-applicable');
    expect(MIGRATION).toContain('HXAI4: deterministic recommendation cannot claim AI provenance');
    expect(MIGRATION).toContain('CREATE TRIGGER recommendation_events_record_ai_outcome');
    expect(MIGRATION).toContain("'RECOMMENDATION_DISPLAYED'");
    expect(MIGRATION).toContain("'USER_' || NEW.event_type");
    expect(MIGRATION).toContain('CREATE TRIGGER recommendation_outcomes_record_ai_outcome');
    expect(MIGRATION).toContain("'recommendation_outcomes'");
  });

  it('ships through fail-closed startup and the production image', () => {
    expect(RUNNER).toMatch(
      /AI_OBSERVABILITY_CONTRACT_MIGRATION\s*=\s*'20260721_ai_observability_contract'/,
    );
    expect(RUNNER).toContain("fileName: '20260721_ai_observability_contract.sql'");
    expect(DOCKERFILE).toContain('/app/backend/database/migrations/20260721_ai_observability_contract.sql');
  });
});
