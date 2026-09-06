import { z } from 'zod';
import { db } from '../db.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { withCommittedFakeFinancialOutcomeAuthority } from './fake-financial-outcome.js';
import type { FakeFinancialProgressInput } from './fake-financial-progress.js';
import {
  FAKE_FINANCIAL_OUTBOX_JOB,
  FAKE_FINANCIAL_OUTBOX_QUEUE,
  fakeFinancialOutboxJobPayload,
  matchesStoredFakeFinancialJob,
  type FakeFinancialOutboxTransport,
} from './fake-financial-outbox-publisher.js';
import { recoverSyntheticFinancialCommand } from './synthetic-financial-worker.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const scanInput = z
  .object({ afterOutboxRequestId: uuid.nullable(), limit: z.number().int().min(1).max(100) })
  .strict();
const candidateSchema = z
  .object({
    outbox_request_id: uuid,
    command_id: uuid,
    bullmq_job_id: z.string(),
    job_authority_sha256: digest,
    admission_present: z.boolean(),
    publication_confirmed: z.boolean(),
    publication_held: z.boolean(),
  })
  .strict();
const restorationSchema = z
  .object({
    outbox_request_id: uuid,
    command_id: uuid,
    bullmq_job_id: z.string(),
    job_authority_sha256: digest,
    queue_name: z.literal(FAKE_FINANCIAL_OUTBOX_QUEUE),
    job_name: z.literal(FAKE_FINANCIAL_OUTBOX_JOB),
    job_payload: fakeFinancialOutboxJobPayload,
    historical_publish_outcome_id: uuid,
  })
  .strict();
export type FakeFinancialRecoveryCandidate = Readonly<z.infer<typeof candidateSchema>>;
function refuse(reason: string): never {
  throw new Error('FAKE_FINANCIAL_DURABLE_RECOVERY_' + reason);
}

function bindingFor(candidate: FakeFinancialRecoveryCandidate): FakeFinancialProgressInput {
  if (
    candidate.bullmq_job_id !==
    'hx-fake-fin-' + candidate.command_id.replaceAll('-', '') + '-' + candidate.job_authority_sha256
  )
    return refuse('JOB_IDENTITY_MISMATCH');
  return Object.freeze({
    jobId: candidate.bullmq_job_id,
    payload: Object.freeze({
      version: 1 as const,
      kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
      outboxRequestId: candidate.outbox_request_id,
      commandId: candidate.command_id,
      jobAuthoritySha256: candidate.job_authority_sha256,
    }),
  });
}

/** Worker-only fixed reads. No raw table access, borrowed publication lease or dispatch capability. */
export class PostgresFakeFinancialDurableRecoveryRepository {
  async scan(value: z.infer<typeof scanInput>): Promise<readonly FakeFinancialRecoveryCandidate[]> {
    const input = Object.freeze(scanInput.parse(value));
    return withCommittedFakeFinancialOutcomeAuthority(() =>
      db.transaction(async (query) => {
        const result = await query(
          'SELECT * FROM public.hxos_scan_fake_financial_recovery_v13($1,$2)',
          [input.afterOutboxRequestId, input.limit]
        );
        if (result.rowCount !== result.rows.length || result.rows.length > input.limit)
          return refuse('SCAN_CARDINALITY');
        let previous = input.afterOutboxRequestId;
        const commandIds = new Set<string>();
        return Object.freeze(
          result.rows.map((value) => {
            const candidate = candidateSchema.parse(value);
            bindingFor(candidate);
            if (
              (previous !== null && candidate.outbox_request_id <= previous) ||
              commandIds.has(candidate.command_id)
            )
              return refuse('SCAN_ORDER_OR_DUPLICATE');
            previous = candidate.outbox_request_id;
            commandIds.add(candidate.command_id);
            return Object.freeze(candidate);
          })
        );
      })
    );
  }

  async readRestoration(value: FakeFinancialRecoveryCandidate) {
    const candidate = Object.freeze(candidateSchema.parse(value));
    const binding = bindingFor(candidate);
    return withCommittedFakeFinancialOutcomeAuthority(() =>
      db.transaction(async (query) => {
        const result = await query(
          'SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)',
          [candidate.outbox_request_id, binding.jobId, candidate.job_authority_sha256]
        );
        if (result.rowCount !== 1 || result.rows.length !== 1)
          return refuse('RESTORATION_CARDINALITY');
        const row = restorationSchema.parse(result.rows[0]);
        if (
          row.outbox_request_id !== candidate.outbox_request_id ||
          row.command_id !== candidate.command_id ||
          row.bullmq_job_id !== binding.jobId ||
          row.job_authority_sha256 !== candidate.job_authority_sha256 ||
          row.job_payload.outboxRequestId !== candidate.outbox_request_id ||
          row.job_payload.commandId !== candidate.command_id ||
          row.job_payload.jobAuthoritySha256 !== candidate.job_authority_sha256
        )
          return refuse('RESTORATION_BINDING_MISMATCH');
        Object.freeze(row.job_payload);
        return Object.freeze(row);
      })
    );
  }
}

export interface FakeFinancialDurableRecoveryResult {
  readonly scanned: number;
  readonly recovered: number;
  readonly transportConfirmed: number;
  readonly awaitingPublisher: number;
  readonly held: number;
  readonly errors: number;
  readonly deferred: number;
  readonly sweepCompleted: boolean;
}

/** UUID keyset sweeps revisit failures on the next pass without starving later work. */
export class FakeFinancialDurableRecovery {
  private cursor: string | null = null;
  private running = false;
  constructor(
    private readonly dependencies: {
      repository: Pick<PostgresFakeFinancialDurableRecoveryRepository, 'scan' | 'readRestoration'>;
      transport: FakeFinancialOutboxTransport;
      recover: (binding: FakeFinancialProgressInput) => Promise<unknown>;
      assertAuthorized: () => void;
    },
    private readonly batchLimit = 20
  ) {
    z.number().int().min(1).max(100).parse(batchLimit);
  }

  async runOnce(signal?: AbortSignal): Promise<FakeFinancialDurableRecoveryResult> {
    if (this.running) return refuse('ALREADY_RUNNING');
    this.running = true;
    let recovered = 0,
      transportConfirmed = 0,
      awaitingPublisher = 0,
      held = 0,
      errors = 0,
      scanned = 0,
      deferred = 0;
    try {
      if (signal?.aborted)
        return Object.freeze({
          scanned,
          recovered,
          transportConfirmed,
          awaitingPublisher,
          held,
          errors,
          deferred,
          sweepCompleted: false,
        });
      this.dependencies.assertAuthorized();
      const rows = await this.dependencies.repository.scan({
        afterOutboxRequestId: this.cursor,
        limit: this.batchLimit,
      });
      for (const row of rows) {
        if (signal?.aborted) break;
        this.dependencies.assertAuthorized();
        try {
          let restore = !row.admission_present;
          if (row.admission_present) {
            // Historical publication holds cannot authorize dispatch; recovery reads durable evidence only.
            const result = await this.dependencies.recover(bindingFor(row));
            if (
              result &&
              typeof result === 'object' &&
              'state' in result &&
              result.state === 'REDISPATCH_REQUIRED'
            ) {
              const receipt = z
                .object({
                  commandId: uuid,
                  state: z.literal('REDISPATCH_REQUIRED'),
                  outcomeFactId: uuid,
                })
                .strict()
                .parse(result);
              if (receipt.commandId !== row.command_id)
                return refuse('REDISPATCH_BINDING_MISMATCH');
              restore = true;
            } else recovered++;
          }
          if (restore && row.publication_held) held++;
          else if (restore && !row.publication_confirmed) awaitingPublisher++;
          else if (restore) {
            const restoration = await this.dependencies.repository.readRestoration(row);
            if (signal?.aborted) break;
            this.dependencies.assertAuthorized();
            const stored = await this.dependencies.transport.publish(restoration, signal);
            if (signal?.aborted) break;
            this.dependencies.assertAuthorized();
            // An existing failed/completed/exhausted job remains evidence. Never reset or remove it.
            if (
              !matchesStoredFakeFinancialJob(restoration, stored) ||
              !['waiting', 'active', 'delayed'].includes(String(stored?.state)) ||
              !z.number().int().min(0).max(63).safeParse(stored?.attemptsMade).success
            )
              held++;
            else transportConfirmed++;
          }
        } catch (error) {
          if (
            row.admission_present &&
            error instanceof Error &&
            (error.message === 'FAKE_FINANCIAL_WORKER_JOB_ALREADY_RUNNING' ||
              ('code' in error &&
                error.code === 'P0001' &&
                [
                  'HXFPCREC1-V13: command already has an active recovery lease',
                  'HXFPCREC1-V13: dispatch outcome deadline has not elapsed',
                  'HXUV1-FINRESTORE-13-FENCE_NOT_DUE',
                  'HXUV1-FINFENCE-13-DISPATCH_ALREADY_FENCED',
                ].includes(error.message)))
          )
            deferred++;
          else errors++;
        }
        this.cursor = row.outbox_request_id;
        scanned++;
      }
      const sweepCompleted =
        !signal?.aborted && scanned === rows.length && rows.length < this.batchLimit;
      if (sweepCompleted) this.cursor = null;
      return Object.freeze({
        scanned,
        recovered,
        transportConfirmed,
        awaitingPublisher,
        held,
        errors,
        deferred,
        sweepCompleted,
      });
    } finally {
      this.running = false;
    }
  }
}

export function createFakeFinancialDurableRecovery(transport: FakeFinancialOutboxTransport) {
  return new FakeFinancialDurableRecovery({
    repository: new PostgresFakeFinancialDurableRecoveryRepository(),
    transport,
    recover: recoverSyntheticFinancialCommand,
    assertAuthorized: () => {
      assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
    },
  });
}
