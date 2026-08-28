import type { Job } from 'bullmq';

import {
  syntheticFinancialCommandAuthority,
  type SyntheticFinancialCommandAuthority,
} from '../services/payment/SyntheticFinancialCommandAuthority.js';
import {
  syntheticFinancialJobEnvelopeSchema,
  type SyntheticFinancialEventRouteCommand,
  type SyntheticFinancialJobEnvelope,
  type SyntheticReconciliationRouteCommand,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
  type ExecuteUniversalV1ReconciliationCommand,
  type UniversalV1FakeFinancialApplicationService,
} from '../services/payment/UniversalV1FinancialApplicationService.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  enqueueJob,
  signJobPayload,
  verifyJobSignature,
} from './queues.js';

const JOB_NAMES = {
  FINANCIAL_EVENT: 'synthetic_finance.event',
  RECONCILIATION: 'synthetic_finance.reconciliation',
} as const;

interface SyntheticFinancialWorkerDependencies {
  readonly authority: Pick<
    SyntheticFinancialCommandAuthority,
    'assertTaskParticipant' | 'assertWorkOrderParticipant'
  >;
  readonly createService: () => UniversalV1FakeFinancialApplicationService;
  readonly verifySignature: (payload: Record<string, unknown>, signature: string) => boolean;
}

interface SyntheticFinancialEnqueueDependencies {
  readonly authority: Pick<
    SyntheticFinancialCommandAuthority,
    'assertTaskParticipant' | 'assertWorkOrderParticipant'
  >;
  readonly assertAuthorized: () => void;
  readonly sign: (payload: Record<string, unknown>) => string;
  readonly enqueue: typeof enqueueJob;
}

const runtimeWorkerDependencies: SyntheticFinancialWorkerDependencies = {
  authority: syntheticFinancialCommandAuthority,
  createService: createUniversalV1FakeFinancialApplicationService,
  verifySignature: verifyJobSignature,
};

const runtimeEnqueueDependencies: SyntheticFinancialEnqueueDependencies = {
  authority: syntheticFinancialCommandAuthority,
  assertAuthorized: () => {
    assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
  },
  sign: signJobPayload,
  enqueue: enqueueJob,
};

function signedJobData(envelope: SyntheticFinancialJobEnvelope, sign: (payload: Record<string, unknown>) => string) {
  const payload = { ...envelope } as Record<string, unknown>;
  return { payload, _sig: sign(payload) };
}

function eventJobId(command: SyntheticFinancialEventRouteCommand): string {
  return [
    'synthetic-finance-event',
    command.operationId,
    command.providerExpectedVersion,
    command.lifecycleExpectedVersion,
  ].join('-');
}

function reconciliationJobId(command: SyntheticReconciliationRouteCommand): string {
  return [
    'synthetic-finance-reconciliation',
    command.operationId,
    command.providerExpectedVersion,
    command.snapshot.reconciliationVersion,
  ].join('-');
}

export async function enqueueSyntheticFinancialEvent(
  actorId: string,
  command: SyntheticFinancialEventRouteCommand,
  dependencies: SyntheticFinancialEnqueueDependencies = runtimeEnqueueDependencies,
): Promise<{ queue: 'synthetic_finance'; jobId: string }> {
  dependencies.assertAuthorized();
  await dependencies.authority.assertTaskParticipant(actorId, command.taskDraftId, command.taskId);
  const envelope = syntheticFinancialJobEnvelopeSchema.parse({
    version: 1,
    kind: 'FINANCIAL_EVENT',
    actorId,
    command,
  });
  const expectedJobId = eventJobId(command);
  const job = await dependencies.enqueue(
    'synthetic_finance',
    JOB_NAMES.FINANCIAL_EVENT,
    signedJobData(envelope, dependencies.sign),
    { jobId: expectedJobId },
  );
  return { queue: 'synthetic_finance', jobId: job.id ?? expectedJobId };
}

export async function enqueueSyntheticReconciliation(
  actorId: string,
  command: SyntheticReconciliationRouteCommand,
  dependencies: SyntheticFinancialEnqueueDependencies = runtimeEnqueueDependencies,
): Promise<{ queue: 'synthetic_finance'; jobId: string }> {
  dependencies.assertAuthorized();
  await dependencies.authority.assertWorkOrderParticipant(actorId, command.snapshot.workOrderId);
  const envelope = syntheticFinancialJobEnvelopeSchema.parse({
    version: 1,
    kind: 'RECONCILIATION',
    actorId,
    command,
  });
  const expectedJobId = reconciliationJobId(command);
  const job = await dependencies.enqueue(
    'synthetic_finance',
    JOB_NAMES.RECONCILIATION,
    signedJobData(envelope, dependencies.sign),
    { jobId: expectedJobId },
  );
  return { queue: 'synthetic_finance', jobId: job.id ?? expectedJobId };
}

function verifiedEnvelope(
  job: Job,
  verifySignature: SyntheticFinancialWorkerDependencies['verifySignature'],
): SyntheticFinancialJobEnvelope {
  const rawPayload = job.data?.payload;
  const signature = job.data?._sig;
  if (
    !rawPayload
    || typeof rawPayload !== 'object'
    || Array.isArray(rawPayload)
    || typeof signature !== 'string'
    || !verifySignature(rawPayload as Record<string, unknown>, signature)
  ) {
    throw new Error('SYNTHETIC_FINANCIAL_JOB_SIGNATURE_INVALID');
  }
  const envelope = syntheticFinancialJobEnvelopeSchema.parse(rawPayload);
  if (job.name !== JOB_NAMES[envelope.kind]) {
    throw new Error('SYNTHETIC_FINANCIAL_JOB_KIND_MISMATCH');
  }
  return envelope;
}

export async function processSyntheticFinancialJob(
  job: Job,
  dependencies: SyntheticFinancialWorkerDependencies = runtimeWorkerDependencies,
): Promise<unknown> {
  const envelope = verifiedEnvelope(job, dependencies.verifySignature);
  const service = dependencies.createService();
  if (envelope.kind === 'FINANCIAL_EVENT') {
    await dependencies.authority.assertTaskParticipant(
      envelope.actorId,
      envelope.command.taskDraftId,
      envelope.command.taskId,
    );
    return service.executeFinancialEvent({
      ...envelope.command,
      recordedBy: envelope.actorId,
    } as ExecuteUniversalV1FinancialEventCommand);
  }

  await dependencies.authority.assertWorkOrderParticipant(
    envelope.actorId,
    envelope.command.snapshot.workOrderId,
  );
  return service.reconcile({
    ...envelope.command,
    snapshot: {
      ...envelope.command.snapshot,
      recordedBy: envelope.actorId,
    },
  } as ExecuteUniversalV1ReconciliationCommand);
}
