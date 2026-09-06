import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { db } from '../db.js';
import { fakeFinancialOutboxJobPayload } from './fake-financial-outbox-publisher.js';
import { decodeFakeFinancialRecoveryEvidenceRow } from './fake-financial-recovery-evidence.js';
import {
  decodeFakeFinancialOutcomeRow,
  fakeFinancialOutcomeReceiptSchema,
  withCommittedFakeFinancialOutcomeAuthority,
} from './fake-financial-outcome.js';

const inputSchema = z
  .object({ jobId: z.string(), payload: fakeFinancialOutboxJobPayload })
  .strict();
const responseSchema = z
  .object({
    recovery_evidence: z.record(z.unknown()),
    recorded_outcome: fakeFinancialOutcomeReceiptSchema.nullable(),
  })
  .strict();
export type FakeFinancialProgressInput = z.infer<typeof inputSchema>;
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_PROGRESS_${reason}`);
}

/** Reads previously committed facts using only the retained job identity.
 * Missing facts do not authorize provider dispatch or prove no effect. */
export async function readFakeFinancialProgress(value: FakeFinancialProgressInput) {
  const input = inputSchema.parse(value);
  if (
    input.jobId !==
    `hx-fake-fin-${input.payload.commandId.replaceAll('-', '')}-${input.payload.jobAuthoritySha256}`
  )
    return refuse('JOB_IDENTITY_MISMATCH');
  Object.freeze(input.payload);
  Object.freeze(input);
  return withCommittedFakeFinancialOutcomeAuthority((authority) =>
    db.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_read_fake_financial_progress_v13($1,$2,$3)',
        [input.payload.outboxRequestId, input.jobId, input.payload.jobAuthoritySha256]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('CARDINALITY');
      return decodeFakeFinancialProgressRow(result.rows[0], input, authority);
    })
  );
}

/** Pure consistency validation; authoritative provenance is the sealed DB port. */
export function decodeFakeFinancialProgressRow(
  value: unknown,
  input: FakeFinancialProgressInput,
  authority: Parameters<typeof decodeFakeFinancialOutcomeRow>[2]
) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return refuse('RESPONSE_INVALID');
  const recovered = decodeFakeFinancialRecoveryEvidenceRow(
    parsed.data.recovery_evidence,
    input,
    authority
  );
  const receipt = parsed.data.recorded_outcome;
  if (receipt === null) return Object.freeze({ ...recovered, recordedOutcome: null });
  if (!recovered.admission || receipt.idempotency_replayed !== true)
    return refuse('COMMITTED_OUTCOME_REQUIRED');
  const recorded = decodeFakeFinancialOutcomeRow(
    receipt,
    {
      ...input,
      jobValidationId: recovered.admission.evidence.job_validation_id,
      recoveryLeaseId: receipt.recovery_lease.recovery_lease_id,
      workerInstanceId: receipt.recovery_lease.lease_owner_id,
    },
    authority
  );
  if (
    Object.entries(recovered.admission.evidence).some(
      ([key, expected]) =>
        recorded.admission.evidence[key as keyof typeof recorded.admission.evidence] !== expected
    ) ||
    (recorded.observation &&
      !isDeepStrictEqual(recorded.observation.event, recovered.observation?.event))
  )
    return refuse('OUTCOME_BINDING_MISMATCH');
  // A historical UNKNOWN remains UNKNOWN even if the independent raw-event
  // read now sees a later committed event. A new observation owns that transition.
  return Object.freeze({ ...recovered, recordedOutcome: recorded });
}
