import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, hasDb } from '../../src/db.js';

describe.sequential.skipIf(!hasDb)('AI spend attempt ledger PostgreSQL authority', () => {
  it('preserves one RESERVED fact and one immutable terminal fact', async () => {
    const operationId = `pg-ledger:${randomUUID()}`;
    const attemptId = '0:openai:0';
    const subjectHash = createHash('sha256').update(`subject:${randomUUID()}`).digest('hex');
    const values = [operationId, attemptId, 'agent-test', subjectHash, 'openai', 'model-test', randomUUID(), 20700, 9];

    await db.query(
      `INSERT INTO public.ai_spend_attempt_events (
         operation_id,attempt_id,transition,agent_type,subject_ref_hash,
         provider_kind,provider_model,request_fingerprint,budget_day,reserved_cents
       ) VALUES ($1,$2,'RESERVED',$3,$4,$5,$6,$7,$8,$9)`,
      values,
    );
    await db.query(
      `INSERT INTO public.ai_spend_attempt_events (
         operation_id,attempt_id,transition,agent_type,subject_ref_hash,
         provider_kind,provider_model,request_fingerprint,budget_day,reserved_cents,detail_code
       ) VALUES ($1,$2,'UNKNOWN',$3,$4,$5,$6,$7,$8,$9,'PROVIDER_OUTCOME_UNKNOWN')`,
      values,
    );

    await expect(db.query(
      `INSERT INTO public.ai_spend_attempt_events (
         operation_id,attempt_id,transition,agent_type,subject_ref_hash,
         provider_kind,provider_model,request_fingerprint,budget_day,reserved_cents,actual_cost_cents
       ) VALUES ($1,$2,'SETTLED',$3,$4,$5,$6,$7,$8,$9,3)`,
      values,
    )).rejects.toMatchObject({ code: '23505' });

    await expect(db.query(
      `UPDATE public.ai_spend_attempt_events SET detail_code='MUTATED'
       WHERE operation_id=$1 AND attempt_id=$2 AND transition='UNKNOWN'`,
      [operationId, attemptId],
    )).rejects.toThrow(/append-only/iu);
    await expect(db.query(
      `DELETE FROM public.ai_spend_attempt_events WHERE operation_id=$1 AND attempt_id=$2`,
      [operationId, attemptId],
    )).rejects.toThrow(/append-only/iu);

    const rows = await db.query<{ transition: string }>(
      `SELECT transition FROM public.ai_spend_attempt_events
       WHERE operation_id=$1 AND attempt_id=$2 ORDER BY recorded_at`,
      [operationId, attemptId],
    );
    expect(rows.rows.map((row) => row.transition)).toEqual(['RESERVED', 'UNKNOWN']);
  });

  it('rejects terminal evidence without its exact RESERVED predecessor', async () => {
    const operationId = `pg-ledger-orphan:${randomUUID()}`;
    await expect(db.query(
      `INSERT INTO public.ai_spend_attempt_events (
         operation_id,attempt_id,transition,agent_type,subject_ref_hash,
         provider_kind,provider_model,request_fingerprint,budget_day,reserved_cents,detail_code
       ) VALUES ($1,'0:x:0','RELEASED','agent-test',$2,'x','model','fingerprint',20700,1,'PROVEN_NO_PROVIDER_IO')`,
      [operationId, createHash('sha256').update(operationId).digest('hex')],
    )).rejects.toThrow(/RESERVED predecessor/iu);
  });
});
