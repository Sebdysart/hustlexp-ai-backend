import type { Job } from 'bullmq';

import {
  syntheticFinancialCommandAuthority,
  type SyntheticFinancialCommandAuthority,
} from '../services/payment/SyntheticFinancialCommandAuthority.js';
import {
  refusePublicSyntheticReconciliation,
  syntheticFinancialEventCommandSchema,
  syntheticFinancialJobEnvelopeSchema,
  type SyntheticFinancialEventRouteCommand,
  type SyntheticFinancialJobEnvelope,
  type SyntheticReconciliationRouteCommand,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
  type UniversalV1FakeFinancialApplicationService,
} from '../services/payment/UniversalV1FinancialApplicationService.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { enqueueJob, signJobPayload, verifyJobSignature } from './queues.js';

const JOB_NAMES = {
  FINANCIAL_EVENT: 'synthetic_finance.event',
} as const;

interface SyntheticFinancialWorkerDependencies {
  readonly authority: Pick<SyntheticFinancialCommandAuthority, 'assertTaskParticipant'>;
  readonly createService: () => UniversalV1FakeFinancialApplicationService;
  readonly verifySignature: (payload: Record<string, unknown>, signature: string) => boolean;
}

interface SyntheticFinancialEnqueueDependencies {
  readonly authority: Pick<SyntheticFinancialCommandAuthority, 'assertTaskParticipant'>;
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

function signedJobData(
  envelope: SyntheticFinancialJobEnvelope,
  sign: (payload: Record<string, unknown>) => string
) {
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

export async function enqueueSyntheticFinancialEvent(
  actorId: string,
  command: SyntheticFinancialEventRouteCommand,
  dependencies: SyntheticFinancialEnqueueDependencies = runtimeEnqueueDependencies
): Promise<{ queue: 'synthetic_finance'; jobId: string }> {
  const parsedCommand = syntheticFinancialEventCommandSchema.parse(command);
  dependencies.assertAuthorized();
  await dependencies.authority.assertTaskParticipant(
    actorId,
    parsedCommand.taskDraftId,
    parsedCommand.taskId
  );
  const envelope = syntheticFinancialJobEnvelopeSchema.parse({
    version: 1,
    kind: 'FINANCIAL_EVENT',
    actorId,
    command: parsedCommand,
  });
  const expectedJobId = eventJobId(parsedCommand);
  const job = await dependencies.enqueue(
    'synthetic_finance',
    JOB_NAMES.FINANCIAL_EVENT,
    signedJobData(envelope, dependencies.sign),
    { jobId: expectedJobId }
  );
  return { queue: 'synthetic_finance', jobId: job.id ?? expectedJobId };
}

export async function enqueueSyntheticReconciliation(
  actorId: string,
  command: SyntheticReconciliationRouteCommand,
  dependencies: SyntheticFinancialEnqueueDependencies = runtimeEnqueueDependencies
): Promise<{ queue: 'synthetic_finance'; jobId: string }> {
  void actorId;
  void command;
  void dependencies;
  return refusePublicSyntheticReconciliation();
}

function verifiedEnvelope(
  job: Job,
  verifySignature: SyntheticFinancialWorkerDependencies['verifySignature']
): SyntheticFinancialJobEnvelope {
  const rawPayload = job.data?.payload;
  const signature = job.data?._sig;
  if (
    !rawPayload ||
    typeof rawPayload !== 'object' ||
    Array.isArray(rawPayload) ||
    typeof signature !== 'string' ||
    !verifySignature(rawPayload as Record<string, unknown>, signature)
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
  dependencies: SyntheticFinancialWorkerDependencies = runtimeWorkerDependencies
): Promise<unknown> {
  const envelope = verifiedEnvelope(job, dependencies.verifySignature);
  const service = dependencies.createService();
  await dependencies.authority.assertTaskParticipant(
    envelope.actorId,
    envelope.command.taskDraftId,
    envelope.command.taskId
  );
  return service.executeFinancialEvent({
    ...envelope.command,
    recordedBy: envelope.actorId,
  } as ExecuteUniversalV1FinancialEventCommand);
}
