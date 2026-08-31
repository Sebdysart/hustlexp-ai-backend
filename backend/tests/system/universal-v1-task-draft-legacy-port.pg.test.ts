import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1'
    || parsed.port !== '5432'
    || parsed.username !== 'hx_ci_runner'
    || parsed.pathname !== '/hx_ci_system_test'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'Legacy TaskDraft port proof may run only on the exact disposable system database',
    );
  }
}

describePg('Universal V1 legacy task-draft-public PostgreSQL port', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('requires an exact receipt by commit and keeps imported rows read-only', async () => {
    const client = await pool.connect();
    const batchId = randomUUID();
    const draftId = randomUUID();
    const submissionId = randomUUID();
    const sourceManifestHash = randomBytes(32).toString('hex');
    const sourceRowHash = randomBytes(32).toString('hex');
    const cardTokenHash = randomBytes(32).toString('hex');
    const preparerId = randomUUID();
    const reviewerId = randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users(id, email, full_name, default_mode) VALUES
           ($1, $2, 'Legacy import preparer', 'poster'),
           ($3, $4, 'Legacy import reviewer', 'poster')`,
        [
          preparerId,
          `legacy-preparer-${preparerId}@test.invalid`,
          reviewerId,
          `legacy-reviewer-${reviewerId}@test.invalid`,
        ],
      );

      await client.query(
        `INSERT INTO task_draft_legacy_import_batches(
           id, source_system, source_environment, source_manifest_sha256,
           source_row_count, rate_continuity_mode, prepared_by, reviewed_by,
           prepared_at, reviewed_at
         ) VALUES (
           $1, 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC', 'required-test', $2,
           1, 'FAIL_CLOSED', $3, $4, clock_timestamp(), clock_timestamp()
         )`,
        [batchId, sourceManifestHash, preparerId, reviewerId],
      );

      const insertDraft = () => client.query(
        `INSERT INTO task_drafts(
           id, submission_id, card_token_hash, category, raw_input, structured,
           status, source, utm, universal_contract_version,
           ingress_contract_version, ingress_origin, card_token_contract_version,
           legacy_import_batch_id, legacy_source_row_sha256,
           legacy_import_disposition
         ) VALUES (
           $1, $2, $3, 'other', 'Legacy compatibility contract fixture', '{}'::jsonb,
           'draft', 'legacy_supabase_task_draft_public', '{}'::jsonb, 0,
           0, 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC', 0,
           $4, $5, 'IMPORTED_READ_ONLY'
         )`,
        [draftId, submissionId, cardTokenHash, batchId, sourceRowHash],
      );

      await client.query('SAVEPOINT orphan_receipt');
      await insertDraft();
      await expect(
        client.query(
          'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard IMMEDIATE',
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('requires its exact immutable receipt by commit'),
      });
      await client.query('ROLLBACK TO SAVEPOINT orphan_receipt');
      await client.query(
        'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard DEFERRED',
      );

      await insertDraft();
      await client.query(
        `INSERT INTO task_draft_legacy_import_receipts(
           import_batch_id, source_row_sha256, target_row_sha256,
           source_submission_id, source_card_token_hash, target_card_token_hash,
           target_task_draft_id, import_disposition, lead_disposition,
           token_disposition, route_disposition, reason_codes, recorded_by
         ) VALUES (
           $1, $2, $3, $4, $5, $5, $6,
           'IMPORTED_READ_ONLY', 'UNRESOLVED', 'HASH_ONLY_READ_ONLY',
           'NO_SYNTHETIC_ROUTE', ARRAY['LEGACY_PORT_CONTRACT_TEST'], $7
         )`,
        [
          batchId,
          sourceRowHash,
          randomBytes(32).toString('hex'),
          submissionId,
          cardTokenHash,
          draftId,
          reviewerId,
        ],
      );
      await expect(
        client.query(
          'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard IMMEDIATE',
        ),
      ).resolves.toMatchObject({ command: 'SET' });

      await client.query('SAVEPOINT immutable_legacy_row');
      await expect(
        client.query(
          `UPDATE task_drafts
              SET raw_input = 'Attempted legacy mutation'
            WHERE id = $1`,
          [draftId],
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('read-only pending an explicit adoption contract'),
      });
      await client.query('ROLLBACK TO SAVEPOINT immutable_legacy_row');

      const authority = await client.query<{
        universal_contract_version: number;
        active_routing_decision_id: string | null;
        lead_id: string | null;
        poster_user_id: string | null;
        task_id: string | null;
        quote_id: string | null;
        routes: number;
      }>(
        `SELECT draft.universal_contract_version,
                draft.active_routing_decision_id, draft.lead_id,
                draft.poster_user_id, draft.task_id, draft.quote_id,
                (SELECT COUNT(*)::integer
                   FROM task_routing_decisions route
                  WHERE route.task_draft_id = draft.id) AS routes
           FROM task_drafts draft
          WHERE draft.id = $1`,
        [draftId],
      );
      expect(authority.rows).toEqual([{
        universal_contract_version: 0,
        active_routing_decision_id: null,
        lead_id: null,
        poster_user_id: null,
        task_id: null,
        quote_id: null,
        routes: 0,
      }]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
