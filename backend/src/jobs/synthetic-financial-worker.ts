import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  FAKE_FINANCIAL_OUTBOX_JOB,
  FAKE_FINANCIAL_OUTBOX_QUEUE,
  fakeFinancialOutboxJobPayload,
} from './fake-financial-outbox-publisher.js';
import { PostgresFakeFinancialAdmittedRequestRepository } from './fake-financial-admitted-request.js';
import {
  issueAdmittedFakeFinancialExecutionCapability,
  executeAdmittedFakeFinancialCommand,
} from './fake-financial-admitted-execution.js';
import {
  readFakeFinancialProgress,
  type FakeFinancialProgressInput,
} from './fake-financial-progress.js';
import {
  acquireFakeFinancialReconcileLease,
  recordFakeFinancialOutcome,
} from './fake-financial-outcome.js';
import { materializeFakeFinancialEvent } from './fake-financial-materialization.js';

interface FinancialCommandProcessorDependencies {
  readonly assertAuthorized: () => void;
  readonly readProgress: typeof readFakeFinancialProgress;
  readonly admit: PostgresFakeFinancialAdmittedRequestRepository['admit'];
  readonly issueExecutionCapability: typeof issueAdmittedFakeFinancialExecutionCapability;
  readonly execute: typeof executeAdmittedFakeFinancialCommand;
  readonly acquireReconcileLease: typeof acquireFakeFinancialReconcileLease;
  readonly recordOutcome: typeof recordFakeFinancialOutcome;
  readonly materialize: typeof materializeFakeFinancialEvent;
}
const admissions = new PostgresFakeFinancialAdmittedRequestRepository();
const runtimeDependencies: FinancialCommandProcessorDependencies = {
  assertAuthorized: () => {
    assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  },
  readProgress: readFakeFinancialProgress,
  admit: (input) => admissions.admit(input),
  issueExecutionCapability: issueAdmittedFakeFinancialExecutionCapability,
  execute: executeAdmittedFakeFinancialCommand,
  acquireReconcileLease: acquireFakeFinancialReconcileLease,
  recordOutcome: recordFakeFinancialOutcome,
  materialize: materializeFakeFinancialEvent,
};
function refuse(reason: string): never {
  throw new Error('FAKE_FINANCIAL_WORKER_' + reason);
}

/** Each resumed invocation reads committed progress first. A new queue admission
 * requires a committed database no-effect fence for any prior dispatch. */
export class SyntheticFinancialCommandProcessor {
  private readonly reconcileLeases = new Map<string, string>();
  private readonly activeJobs = new Set<string>();
  constructor(
    private readonly dependencies: FinancialCommandProcessorDependencies = runtimeDependencies,
    private readonly workerInstanceId: string = randomUUID()
  ) {
    z.string().uuid().parse(workerInstanceId);
  }

  async process(job: Pick<Job, 'name' | 'id' | 'data' | 'attemptsMade' | 'queueName'>) {
    if (job.name !== FAKE_FINANCIAL_OUTBOX_JOB || job.queueName !== FAKE_FINANCIAL_OUTBOX_QUEUE)
      return refuse('JOB_KIND_MISMATCH');
    const payload = Object.freeze(fakeFinancialOutboxJobPayload.parse(job.data));
    const jobId = job.id;
    if (
      jobId !==
      'hx-fake-fin-' + payload.commandId.replaceAll('-', '') + '-' + payload.jobAuthoritySha256
    )
      return refuse('JOB_IDENTITY_MISMATCH');
    const attempt = z.number().int().min(0).max(63).parse(job.attemptsMade);
    return this.runExclusive(Object.freeze({ jobId, payload }), attempt);
  }

  /** Durable discovery can reconcile an admission, but cannot create one. */
  async recover(value: FakeFinancialProgressInput) {
    const binding = z
      .object({ jobId: z.string(), payload: fakeFinancialOutboxJobPayload })
      .strict()
      .parse(value);
    if (
      binding.jobId !==
      'hx-fake-fin-' +
        binding.payload.commandId.replaceAll('-', '') +
        '-' +
        binding.payload.jobAuthoritySha256
    )
      return refuse('JOB_IDENTITY_MISMATCH');
    Object.freeze(binding.payload);
    return this.runExclusive(Object.freeze(binding), null);
  }

  private async runExclusive(binding: FakeFinancialProgressInput, attempt: number | null) {
    if (this.activeJobs.has(binding.jobId)) return refuse('JOB_ALREADY_RUNNING');
    this.activeJobs.add(binding.jobId);
    try {
      const result = await this.processBound(binding, attempt);
      // A normal BullMQ invocation must retry; returning this state would mark
      // an unfinished command completed and strand its retained transport job.
      if (attempt !== null && result.state === 'REDISPATCH_REQUIRED')
        return refuse('REDISPATCH_REQUIRED');
      return result;
    } finally {
      this.activeJobs.delete(binding.jobId);
    }
  }

  private async finish(
    binding: FakeFinancialProgressInput,
    recorded: Awaited<ReturnType<typeof recordFakeFinancialOutcome>>
  ) {
    if (
      recorded.outcome.outcome_kind === 'FAILED' &&
      recorded.outcome.failure_code === 'FAKE_ADMISSION_FENCED_NO_EFFECT'
    ) {
      return Object.freeze({
        commandId: binding.payload.commandId,
        state: 'REDISPATCH_REQUIRED' as const,
        outcomeFactId: recorded.outcome.outcome_fact_id,
      });
    }
    if (recorded.outcome.outcome_kind !== 'OUTCOME_OBSERVED' || recorded.outcome.retryable)
      return refuse('RECOVERY_REQUIRED');
    this.dependencies.assertAuthorized();
    const result = await this.dependencies.materialize({
      ...binding,
      jobValidationId: recorded.admission.evidence.job_validation_id,
      outcomeFactId: recorded.outcome.outcome_fact_id,
    });
    return Object.freeze({
      commandId: binding.payload.commandId,
      state: 'MATERIALIZED' as const,
      outcomeFactId: recorded.outcome.outcome_fact_id,
      financialEventId: result.financialEvent.id,
      idempotencyReplayed: result.idempotencyReplayed,
    });
  }

  private async processBound(binding: FakeFinancialProgressInput, attempt: number | null) {
    this.dependencies.assertAuthorized();
    const progress = await this.dependencies.readProgress(binding);
    const existing = progress.recordedOutcome;
    if (existing) {
      if (this.reconcileLeases.get(binding.jobId) === existing.lease.recovery_lease_id)
        this.reconcileLeases.delete(binding.jobId);
      if (existing.outcome.outcome_kind === 'OUTCOME_OBSERVED' && !existing.outcome.retryable) {
        this.reconcileLeases.delete(binding.jobId);
        return this.finish(binding, existing);
      }
    }
    const fenced =
      existing?.outcome.outcome_kind === 'FAILED' &&
      existing.outcome.failure_code === 'FAKE_ADMISSION_FENCED_NO_EFFECT';
    if (fenced) this.reconcileLeases.delete(binding.jobId);
    if (fenced && attempt === null) return this.finish(binding, existing);
    if ((progress.kind === 'NO_COMMITTED_ADMISSION' && !progress.admission) || fenced) {
      if (attempt === null) return refuse('COMMITTED_ADMISSION_REQUIRED');
      this.dependencies.assertAuthorized();
      const admission = await this.dependencies.admit({
        ...binding,
        workerInstanceId: this.workerInstanceId,
        bullmqAttemptNumber: attempt,
        leaseSeconds: 60,
        outcomeTimeoutSeconds: 45,
      });
      this.dependencies.assertAuthorized();
      const capability = await this.dependencies.issueExecutionCapability(
        admission.job_validation_id,
        this.workerInstanceId
      );
      await this.dependencies.execute(capability);
      const recorded = await this.dependencies.recordOutcome({
        ...binding,
        jobValidationId: admission.job_validation_id,
        workerInstanceId: this.workerInstanceId,
        recoveryLeaseId: admission.recovery_lease_id,
      });
      return this.finish(binding, recorded);
    }
    if (!progress.admission) return refuse('PROGRESS_INCONSISTENT');
    // Retain the chosen UUID across uncertain acknowledgements. A lost process
    // may choose a new UUID; the database still owns lease exclusion and expiry.
    let leaseId = this.reconcileLeases.get(binding.jobId);
    if (!leaseId) {
      if (this.reconcileLeases.size >= 1024) return refuse('RECONCILE_CAPACITY_REACHED');
      leaseId = randomUUID();
      this.reconcileLeases.set(binding.jobId, leaseId);
    }
    this.dependencies.assertAuthorized();
    const input = {
      ...binding,
      jobValidationId: progress.admission.evidence.job_validation_id,
      workerInstanceId: this.workerInstanceId,
      recoveryLeaseId: leaseId,
    };
    try {
      await this.dependencies.acquireReconcileLease({ ...input, leaseSeconds: 60 });
    } catch (error) {
      // These exact trigger refusals prove that this lease insert rolled back.
      // Do not retain cache slots for ordinary work still running elsewhere.
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'P0001' &&
        [
          'HXFPCREC1-V13: command already has an active recovery lease',
          'HXFPCREC1-V13: dispatch outcome deadline has not elapsed',
          'HXFPCREC1-V13: reconciliation requires a due explicit nonterminal outcome',
        ].includes(error.message)
      )
        this.reconcileLeases.delete(binding.jobId);
      throw error;
    }
    let recorded: Awaited<ReturnType<typeof recordFakeFinancialOutcome>>;
    try {
      recorded = await this.dependencies.recordOutcome(input);
    } catch (error) {
      // Database time owns expiry. A precise rejection permits retiring this
      // lease; uncertain acknowledgements must retain its idempotent identity.
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'P0001' &&
        error.message === 'HXFPCREC1: recovery lease expired before outcome commitment'
      )
        this.reconcileLeases.delete(binding.jobId);
      throw error;
    }
    this.reconcileLeases.delete(binding.jobId);
    return this.finish(binding, recorded);
  }
}

const runtimeProcessor = new SyntheticFinancialCommandProcessor();
export async function processSyntheticFinancialJob(job: Job): Promise<unknown> {
  return runtimeProcessor.process(job);
}

export async function recoverSyntheticFinancialCommand(
  binding: FakeFinancialProgressInput
): Promise<unknown> {
  return runtimeProcessor.recover(binding);
}
