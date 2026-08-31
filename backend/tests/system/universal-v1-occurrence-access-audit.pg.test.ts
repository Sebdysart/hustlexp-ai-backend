import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPool, createTestUser, hasDb } from '../setup.js';

const describePg = describe.sequential.skipIf(!hasDb);
const DIGEST = 'a'.repeat(64);

let pool: pg.Pool | undefined;

async function database(): Promise<pg.Pool> {
  if (!pool) throw new Error('PostgreSQL test pool is unavailable');
  return pool;
}

async function fixture() {
  const db = await database();
  const actorId = await createTestUser(
    db,
    `occurrence-audit-${randomUUID()}@example.invalid`
  );
  const taskDraftId = randomUUID();
  await db.query(
    `INSERT INTO public.admin_roles(user_id, role, can_manage_operations)
     VALUES ($1, 'support', TRUE)
     ON CONFLICT (user_id) DO UPDATE SET role='support', can_manage_operations=TRUE`,
    [actorId]
  );
  await db.query(
    `INSERT INTO public.task_drafts(
       id, submission_id, card_token_hash, raw_input, universal_contract_version
     ) VALUES ($1, $2, $3, 'Synthetic Operations access-audit proof', 1)`,
    [taskDraftId, randomUUID(), `occurrence-audit-card-${randomUUID()}`]
  );
  return { actorId, taskDraftId };
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
  const relation = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.universal_v1_occurrence_access_audit')::text AS relation"
  );
  if (relation.rows[0]?.relation !== 'universal_v1_occurrence_access_audit') {
    throw new Error('Universal V1 occurrence access audit migration is not installed');
  }
});

afterAll(async () => {
  await pool?.end();
});

describePg('Universal V1 Operations occurrence access audit PostgreSQL authority', () => {
  it('records exact purpose/digest with current role and database observation time', async () => {
    const db = await database();
    const { actorId, taskDraftId } = await fixture();
    const before = Date.now();
    const inserted = await db.query<{
      id: string;
      actor_role: string;
      purpose: string;
      projection_sha256: string;
      observed_at: Date;
    }>(
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256, observed_at
       ) VALUES ($1, $2, 'support', $3, $4, TIMESTAMPTZ '2000-01-01 00:00:00+00')
       RETURNING id, actor_role, purpose, projection_sha256, observed_at`,
      [taskDraftId, actorId, 'Investigate exact synthetic occurrence evidence.', DIGEST]
    );
    expect(inserted.rows[0]).toMatchObject({
      actor_role: 'support',
      purpose: 'Investigate exact synthetic occurrence evidence.',
      projection_sha256: DIGEST,
    });
    expect(new Date(inserted.rows[0]!.observed_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects role forgery and role revocation without appending evidence', async () => {
    const db = await database();
    const { actorId, taskDraftId } = await fixture();
    const count = async () => Number((await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM public.universal_v1_occurrence_access_audit
        WHERE task_draft_id=$1`,
      [taskDraftId]
    )).rows[0]?.count ?? 0);

    await expect(db.query(
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256
       ) VALUES ($1, $2, 'admin', $3, $4)`,
      [taskDraftId, actorId, 'Attempt forged role observation evidence.', DIGEST]
    )).rejects.toThrow(/HXUVOA1/);
    expect(await count()).toBe(0);

    await db.query(
      'UPDATE public.admin_roles SET can_manage_operations=FALSE WHERE user_id=$1',
      [actorId]
    );
    await expect(db.query(
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256
       ) VALUES ($1, $2, 'support', $3, $4)`,
      [taskDraftId, actorId, 'Attempt observation after authority revocation.', DIGEST]
    )).rejects.toThrow(/HXUOC1/);
    expect(await count()).toBe(0);
  });

  it('rejects update, delete, and truncate while preserving the exact row', async () => {
    const db = await database();
    const { actorId, taskDraftId } = await fixture();
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256
       ) VALUES ($1, $2, 'support', $3, $4)
       RETURNING id`,
      [taskDraftId, actorId, 'Preserve immutable occurrence observation evidence.', DIGEST]
    );
    const id = inserted.rows[0]!.id;
    await expect(db.query(
      `UPDATE public.universal_v1_occurrence_access_audit
          SET purpose='Mutated observation purpose is forbidden.'
        WHERE id=$1`,
      [id]
    )).rejects.toThrow(/HXUVOA3/);
    await expect(db.query(
      'DELETE FROM public.universal_v1_occurrence_access_audit WHERE id=$1',
      [id]
    )).rejects.toThrow(/HXUVOA3/);
    await expect(db.query(
      'TRUNCATE TABLE public.universal_v1_occurrence_access_audit'
    )).rejects.toThrow(/HXUVOA3/);
    const preserved = await db.query<{ purpose: string; projection_sha256: string }>(
      `SELECT purpose, projection_sha256
         FROM public.universal_v1_occurrence_access_audit
        WHERE id=$1`,
      [id]
    );
    expect(preserved.rows[0]).toEqual({
      purpose: 'Preserve immutable occurrence observation evidence.',
      projection_sha256: DIGEST,
    });
  });
});
