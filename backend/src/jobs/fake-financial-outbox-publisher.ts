import { z } from 'zod';
import type { QueryFn } from '../database-contracts.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const FAKE_FINANCIAL_OUTBOX_QUEUE = 'synthetic_finance' as const;
export const FAKE_FINANCIAL_OUTBOX_JOB = 'synthetic_finance.command.v13' as const;

export const fakeFinancialOutboxJobPayload = z
  .object({
    version: z.literal(1),
    kind: z.literal('UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND'),
    outboxRequestId: uuid,
    commandId: uuid,
    jobAuthoritySha256: digest,
  })
  .strict();
export type FakeFinancialOutboxJobPayload = z.infer<typeof fakeFinancialOutboxJobPayload>;

const storedJobOptions = z
  .object({
    jobId: z.string(),
    attempts: z.literal(64),
    backoff: z.object({ type: z.literal('fixed'), delay: z.literal(5_000) }).strict(),
    removeOnComplete: z.literal(false),
    removeOnFail: z.literal(false),
    delay: z.literal(0).optional(),
    timestamp: z.number().int().nonnegative().optional(),
  })
  .strict();

const claimSchema = z
  .object({
    publish_claim_id: uuid,
    outbox_request_id: uuid,
    command_id: uuid,
    bullmq_job_id: z.string(),
    queue_name: z.literal(FAKE_FINANCIAL_OUTBOX_QUEUE),
    job_name: z.literal(FAKE_FINANCIAL_OUTBOX_JOB),
    job_payload: fakeFinancialOutboxJobPayload,
    job_authority_sha256: digest,
    claim_number: z.number().int().min(1).max(64),
    lease_expires_at: z.union([z.date(), z.string().datetime({ offset: true })]),
  })
  .strict();
export type FakeFinancialOutboxClaim = Readonly<z.infer<typeof claimSchema>>;
export type FakeFinancialOutboxPublication = Readonly<
  Pick<
    FakeFinancialOutboxClaim,
    | 'outbox_request_id'
    | 'command_id'
    | 'bullmq_job_id'
    | 'queue_name'
    | 'job_name'
    | 'job_payload'
    | 'job_authority_sha256'
  >
>;

export interface FakeFinancialOutboxDatabase {
  transaction<T>(callback: (query: QueryFn) => Promise<T>): Promise<T>;
}

export interface FakeFinancialOutboxTransport {
  /** Must read back Redis's stored job after add; an add return value is insufficient. */
  publish(
    claim: FakeFinancialOutboxPublication,
    signal?: AbortSignal
  ): Promise<{
    id: unknown;
    queueName: unknown;
    name: unknown;
    data: unknown;
    opts: unknown;
    state?: unknown;
    attemptsMade?: unknown;
  } | null>;
}

/** Verifies the stored transport identity; it never creates a publication claim. */
export function matchesStoredFakeFinancialJob(
  publication: FakeFinancialOutboxPublication,
  stored: Awaited<ReturnType<FakeFinancialOutboxTransport['publish']>>
): boolean {
  const payload = fakeFinancialOutboxJobPayload.safeParse(stored?.data);
  const options = storedJobOptions.safeParse(stored?.opts);
  return (
    !!stored &&
    payload.success &&
    options.success &&
    options.data.jobId === publication.bullmq_job_id &&
    stored.id === publication.bullmq_job_id &&
    stored.name === publication.job_name &&
    stored.queueName === publication.queue_name &&
    payload.data.outboxRequestId === publication.outbox_request_id &&
    payload.data.commandId === publication.command_id &&
    payload.data.jobAuthoritySha256 === publication.job_authority_sha256
  );
}

export type FakeFinancialPublishOutcome =
  | { kind: 'BULLMQ_CONFIRMED' }
  | { kind: 'RETRYABLE_FAILURE'; code: 'REDIS_PUBLICATION_UNCONFIRMED'; retryDelaySeconds: number }
  | { kind: 'TERMINAL_FAILURE'; code: 'REDIS_JOB_IDENTITY_MISMATCH' };

function refuse(code: string): never {
  throw new Error(code);
}

/** Fixed ports only. The production data plane supplies READ COMMITTED and live target verification. */
export class PostgresFakeFinancialOutboxRepository {
  private readonly issuedClaims = new WeakSet<object>();
  constructor(private readonly database: FakeFinancialOutboxDatabase) {}

  async claim(publisherId: string, leaseSeconds: number): Promise<FakeFinancialOutboxClaim | null> {
    uuid.parse(publisherId);
    z.number().int().min(1).max(300).parse(leaseSeconds);
    const row = await this.database.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,$2)',
        [publisherId, leaseSeconds]
      );
      if (result.rowCount !== result.rows.length || result.rows.length > 1)
        return refuse('FAKE_FINANCIAL_OUTBOX_CLAIM_CARDINALITY');
      if (result.rows.length === 0) return null;
      const parsed = claimSchema.safeParse(result.rows[0]);
      if (!parsed.success) return refuse('FAKE_FINANCIAL_OUTBOX_CLAIM_INVALID');
      const claim = parsed.data;
      const payload = claim.job_payload;
      if (
        payload.commandId !== claim.command_id ||
        payload.outboxRequestId !== claim.outbox_request_id ||
        payload.jobAuthoritySha256 !== claim.job_authority_sha256 ||
        claim.bullmq_job_id !==
          `hx-fake-fin-${claim.command_id.replaceAll('-', '')}-${claim.job_authority_sha256}`
      ) {
        return refuse('FAKE_FINANCIAL_OUTBOX_CLAIM_IDENTITY_MISMATCH');
      }
      Object.freeze(payload);
      return Object.freeze(claim);
    });
    // Only a successfully committed claim may reach Redis or acknowledge publication.
    if (row) this.issuedClaims.add(row);
    return row;
  }

  async recordOutcome(
    claim: FakeFinancialOutboxClaim,
    outcome: FakeFinancialPublishOutcome
  ): Promise<void> {
    if (!this.issuedClaims.has(claim)) return refuse('FAKE_FINANCIAL_OUTBOX_CLAIM_NOT_ISSUED');
    this.issuedClaims.delete(claim);
    const confirmed = outcome.kind === 'BULLMQ_CONFIRMED';
    if (outcome.kind === 'RETRYABLE_FAILURE')
      z.number().int().min(1).max(86400).parse(outcome.retryDelaySeconds);
    await this.database.transaction(async (query) => {
      const result = await query<{ outcome_id: string }>(
        'SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,$2,$3,$4,$5,$6) AS outcome_id',
        [
          claim.publish_claim_id,
          outcome.kind,
          confirmed ? claim.bullmq_job_id : null,
          confirmed ? claim.job_authority_sha256 : null,
          confirmed ? null : outcome.code,
          outcome.kind === 'RETRYABLE_FAILURE' ? outcome.retryDelaySeconds : null,
        ]
      );
      if (
        result.rowCount !== 1 ||
        result.rows.length !== 1 ||
        !uuid.safeParse(result.rows[0]?.outcome_id).success
      ) {
        return refuse('FAKE_FINANCIAL_OUTBOX_OUTCOME_INVALID');
      }
    });
  }
}

export interface FakeFinancialOutboxPublisherResult {
  claimed: number;
  confirmed: number;
  retryableFailures: number;
  terminalFailures: number;
  persistenceErrors: number;
}

/** Transport publication only; this component never executes a financial provider. */
export class FakeFinancialOutboxPublisher {
  private running = false;
  constructor(
    private readonly repository: Pick<
      PostgresFakeFinancialOutboxRepository,
      'claim' | 'recordOutcome'
    >,
    private readonly transport: FakeFinancialOutboxTransport,
    private readonly assertAuthorized: () => void,
    private readonly options: {
      publisherId: string;
      leaseSeconds?: number;
      batchLimit?: number;
      retryDelaySeconds?: number;
    }
  ) {
    uuid.parse(options.publisherId);
    z.number()
      .int()
      .min(15)
      .max(300)
      .parse(options.leaseSeconds ?? 60);
    z.number()
      .int()
      .min(1)
      .max(100)
      .parse(options.batchLimit ?? 20);
    z.number()
      .int()
      .min(1)
      .max(86400)
      .parse(options.retryDelaySeconds ?? 5);
  }

  async runOnce(signal?: AbortSignal): Promise<FakeFinancialOutboxPublisherResult> {
    if (this.running) return refuse('FAKE_FINANCIAL_OUTBOX_PUBLISHER_ALREADY_RUNNING');
    this.running = true;
    const result: FakeFinancialOutboxPublisherResult = {
      claimed: 0,
      confirmed: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      persistenceErrors: 0,
    };
    try {
      for (let index = 0; index < (this.options.batchLimit ?? 20); index++) {
        if (signal?.aborted) break;
        this.assertAuthorized();
        const claim = await this.repository.claim(
          this.options.publisherId,
          this.options.leaseSeconds ?? 60
        );
        if (!claim) break;
        result.claimed++;
        if (signal?.aborted) break;
        this.assertAuthorized();
        let outcome: FakeFinancialPublishOutcome;
        try {
          const stored = await this.transport.publish(claim, signal);
          if (!stored) {
            outcome = {
              kind: 'RETRYABLE_FAILURE',
              code: 'REDIS_PUBLICATION_UNCONFIRMED',
              retryDelaySeconds: this.options.retryDelaySeconds ?? 5,
            };
          } else if (!matchesStoredFakeFinancialJob(claim, stored)) {
            outcome = { kind: 'TERMINAL_FAILURE', code: 'REDIS_JOB_IDENTITY_MISMATCH' };
          } else outcome = { kind: 'BULLMQ_CONFIRMED' };
        } catch {
          // A timeout/disconnect cannot establish whether Redis accepted the add.
          // Retry reuses the deterministic identity; never overwrite/remove a job.
          outcome = {
            kind: 'RETRYABLE_FAILURE',
            code: 'REDIS_PUBLICATION_UNCONFIRMED',
            retryDelaySeconds: this.options.retryDelaySeconds ?? 5,
          };
        }
        if (signal?.aborted) break;
        this.assertAuthorized();
        try {
          await this.repository.recordOutcome(claim, outcome);
          if (outcome.kind === 'BULLMQ_CONFIRMED') result.confirmed++;
          else if (outcome.kind === 'RETRYABLE_FAILURE') result.retryableFailures++;
          else result.terminalFailures++;
        } catch {
          // Commit acknowledgement can itself be lost. Leave the durable lease
          // to the database's exact retry/expiry rules, rather than guess success.
          result.persistenceErrors++;
          break;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
