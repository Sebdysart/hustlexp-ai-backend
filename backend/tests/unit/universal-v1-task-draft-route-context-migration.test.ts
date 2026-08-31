import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260924_universal_v1_task_draft_route_context_v1.sql';
const migrationPath = resolve(process.cwd(), 'backend/database/migrations', fileName);
const migration = readFileSync(migrationPath, 'utf8');

describe('Universal V1 TaskDraft route-context migration', () => {
  it('is append-only engine migration 130 after legacy escrow containment', () => {
    const routeContextIndex = REQUIRED_MIGRATION_FILES.findIndex(
      (entry) => entry.name === '20260924_universal_v1_task_draft_route_context_v1',
    );
    expect(routeContextIndex).toBe(129);
    expect(REQUIRED_MIGRATION_FILES.slice(routeContextIndex - 1, routeContextIndex + 1)).toEqual([
      {
        name: '20260923_legacy_escrow_insert_containment_v1',
        fileName: '20260923_legacy_escrow_insert_containment_v1.sql',
      },
      {
        name: '20260924_universal_v1_task_draft_route_context_v1',
        fileName,
      },
    ]);
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('creates an empty, provenance-bound, append-only service-cell authority', () => {
    for (const token of [
      'CREATE TABLE IF NOT EXISTS public.universal_v1_service_cell_authorities',
      "routing_availability IN ('ACTIVE', 'WAITLIST', 'UNAVAILABLE')",
      "authority_environment IN ('local', 'preview', 'staging', 'production')",
      "authority_kind IN ('SYNTHETIC_FIXTURE', 'SIGNED_DATASET')",
      "authority_environment = 'production'",
      'is_test IS FALSE',
      "authority_kind = 'SIGNED_DATASET'",
      "evidence_sha256 = encode(digest(evidence::text, 'sha256'), 'hex')",
      'supersedes_authority_id',
      'universal_v1_service_cell_authorities_immutable',
      'universal_v1_service_cell_authorities_no_truncate',
      'REVOKE ALL ON TABLE public.universal_v1_service_cell_authorities FROM PUBLIC',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+public\.universal_v1_service_cell_authorities/iu,
    );
  });

  it('binds policy 1.2 and preserves exact context through contact and estimate transitions', () => {
    for (const token of [
      'ADD COLUMN IF NOT EXISTS service_cell_authority_id UUID',
      "NEW.policy_version <> 'universal-v1-intake-1.2.0'",
      "ingress_action = 'link_contact'",
      'contact linking must preserve the exact predecessor route',
      "NEW.policy_version = 'universal-v1-estimate-acceptance-1.1.0'",
      'estimate acceptance must preserve the exact predecessor route context',
      "'work_category_code'",
      "'region_code'",
      "'rough_location'",
      "'risk_level'",
      "'requires_proof'",
      "'final_availability_confirmation_required'",
      "'service_cell_evidence_sha256'",
      "NEW.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED')",
      'every route blocker must remain in the routing reason codes',
      "authority.routing_availability = 'WAITLIST'",
      "authority.routing_availability = 'UNAVAILABLE'",
      'current effective service-cell chain tip',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('cannot create a task, assignment, or financial fact', () => {
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+public\.(?:tasks|task_work_orders|task_financial_operations|task_financial_security_events|escrows|payments)\b/iu,
    );
    expect(migration).not.toMatch(/\b(?:stripe|payment_intent|payout)\b/iu);
  });

  it('has no blocker under the repository migration-safety policy', () => {
    expect(
      analyzeMigrationFile(migrationPath, migration).filter(
        (issue) => issue.severity === 'BLOCKER',
      ),
    ).toEqual([]);
  });
});
