import {
  PostgresUniversalV1FinancialPredecessorReader,
  type UniversalV1FinancialPredecessorReader,
} from './UniversalV1FinancialPredecessor.js';
import {
  FakeFinancialPredecessorPayloadSchema,
  FinancialPredecessorFactsSchema,
  financialPredecessorMatchesPayload,
  freezeFinancialPredecessorFacts,
  type FakeFinancialPredecessorPayload,
} from '../../auth/financial-predecessor-command-contract.js';
import { z } from 'zod';
import type { UniversalV1ActorAttestationHandle } from '../../auth/universal-v1-actor-attestation-contracts.js';
import {
  PostgresUniversalV1FinancialRequestProgressReader,
  type UniversalV1FinancialRequestProgressReader,
} from './UniversalV1FinancialRequestProgress.js';
import { PublicFinancialRequestProgressSchema } from '../../auth/financial-progress-command-contract.js';
import {
  isAuthenticatedReleaseManifest,
  readReleaseManifest,
  releaseManifestDigest,
} from '../../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from './NonproductionFinancialAuthorization.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type UniversalV1PreparedFinancialCommandAuthority,
} from './PreparedFinancialCommandAuthority.js';
import {
  PostgresFinancialProviderCommandJournal,
  prepareFinancialProviderCommand,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReleaseEvidence,
} from './FinancialProviderCommandJournal.js';
import {
  prepareUniversalV1FakeFinancialRequest,
  type ExecuteUniversalV1FinancialEventCommand,
} from './UniversalV1FinancialApplicationService.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const releaseSchema = z
  .object({
    manifestDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .refine((value) => value !== 'sha256:' + '0'.repeat(64)),
    releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{7,127}$/u),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .refine((value) => value !== '0'.repeat(40)),
    environment: z.enum(['local', 'preview', 'staging']),
    authenticationStatus: z.literal('VERIFIED'),
  })
  .strict();
const receiptSchema = z
  .object({
    commandId: uuid,
    operationKind: z.string(),
    operationId: uuid,
    providerKind: z.literal('FAKE'),
    idempotencyKey: z.string(),
    providerExpectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestSha256: digest,
    commandIdentitySha256: digest,
    preparedFinancialCommandId: uuid,
    preparedAuthoritySha256: digest,
    recordedAt: z.string().datetime({ offset: true }),
    idempotencyReplayed: z.boolean(),
  })
  .strict();
function refuse(reason: string): never {
  throw new Error('UNIVERSAL_FINANCE_REQUEST_' + reason);
}

export interface RequestedUniversalV1FinancialEvent {
  readonly commandId: string;
  readonly preparedCommandId: string;
  readonly operationId: string;
  /** The immutable request fact, not a claim about delivery or current execution. */
  readonly requestState: 'REQUESTED';
  readonly requestedAt: string;
  readonly idempotencyReplayed: boolean;
}

/** Commits authenticated PREPARED, then exact REQUESTED plus outbox. It never
 * publishes Redis work, calls a provider, or records a financial lifecycle event. */
export class UniversalV1FinancialRequestService {
  constructor(
    private readonly preparedAuthority: UniversalV1PreparedFinancialCommandAuthority,
    private readonly journal: FinancialProviderCommandJournal,
    private readonly authorize: () => FinancialProviderCommandReleaseEvidence,
    private readonly progressReader: UniversalV1FinancialRequestProgressReader = new PostgresUniversalV1FinancialRequestProgressReader(),
    private readonly predecessorReader: UniversalV1FinancialPredecessorReader = new PostgresUniversalV1FinancialPredecessorReader()
  ) {}

  async readProgress(
    commandId: string,
    actorId: string,
    attestation: UniversalV1ActorAttestationHandle | undefined
  ) {
    if (!attestation) return refuse('ACTOR_ATTESTATION_REQUIRED');
    const release = Object.freeze(releaseSchema.parse(this.authorize()));
    const result = await this.progressReader.read(
      uuid.parse(commandId),
      uuid.parse(actorId),
      attestation,
      release
    );
    if (JSON.stringify(releaseSchema.parse(this.authorize())) !== JSON.stringify(release))
      return refuse('RELEASE_AUTHORITY_CHANGED');
    if (result === null) return null;
    const progress = PublicFinancialRequestProgressSchema.parse(result);
    if (progress.commandId !== commandId) return refuse('PROGRESS_BINDING_MISMATCH');
    if (progress.financialEvent) Object.freeze(progress.financialEvent);
    return Object.freeze(progress);
  }

  /** Backend-only historical fact read. Never expose provider references from this result. */
  async readPredecessor(
    expected: FakeFinancialPredecessorPayload,
    actorId: string,
    attestation: UniversalV1ActorAttestationHandle | undefined
  ) {
    if (!attestation) return refuse('ACTOR_ATTESTATION_REQUIRED');
    const payload = FakeFinancialPredecessorPayloadSchema.parse(expected);
    const release = Object.freeze(releaseSchema.parse(this.authorize()));
    const result = await this.predecessorReader.read(
      payload,
      uuid.parse(actorId),
      attestation,
      release
    );
    if (JSON.stringify(releaseSchema.parse(this.authorize())) !== JSON.stringify(release))
      return refuse('RELEASE_AUTHORITY_CHANGED');
    if (result === null) return null;
    const facts = FinancialPredecessorFactsSchema.parse(result);
    if (!financialPredecessorMatchesPayload(facts, payload))
      return refuse('PREDECESSOR_BINDING_MISMATCH');
    return freezeFinancialPredecessorFacts(facts);
  }

  async requestFinancialEvent(
    raw: ExecuteUniversalV1FinancialEventCommand,
    attestation: UniversalV1ActorAttestationHandle | undefined
  ): Promise<RequestedUniversalV1FinancialEvent> {
    if (!attestation) return refuse('ACTOR_ATTESTATION_REQUIRED');
    const release = Object.freeze(releaseSchema.parse(this.authorize()));
    const stableRelease = () => {
      if (JSON.stringify(releaseSchema.parse(this.authorize())) !== JSON.stringify(release))
        return refuse('RELEASE_AUTHORITY_CHANGED');
    };
    const { command, durableRequest, preparationInput } =
      prepareUniversalV1FakeFinancialRequest(raw);
    const prepared = await this.preparedAuthority.prepare(preparationInput, attestation);
    stableRelease();
    const input = {
      operationKind: command.operationKind,
      operationId: command.operationId,
      providerKind: 'FAKE' as const,
      idempotencyKey: command.idempotencyKey,
      providerExpectedVersion: command.providerExpectedVersion,
      exactRequest: durableRequest.request,
      evidence: {
        preparedFinancialCommandId: prepared.preparedCommandId,
        preparedAuthoritySha256: prepared.authorityContextSha256,
        taskDraftId: preparationInput.taskDraftId,
        taskId: preparationInput.taskId ?? undefined,
        workOrderId: prepared.workOrderId ?? undefined,
        ...(command.operationKind === 'PREPARE_PAYMENT_METHOD'
          ? {}
          : {
              relatedOperationId: preparationInput.relatedOperationId!,
              amountCents: preparationInput.amountCents!,
              currency: preparationInput.currency!,
            }),
      },
      actor: { actorId: preparationInput.recordedBy, actorKind: 'PARTICIPANT' as const },
      release,
    };
    const expected = prepareFinancialProviderCommand(input);
    const parsed = receiptSchema.safeParse(await this.journal.recordRequested(input));
    if (!parsed.success) return refuse('RECEIPT_INVALID');
    const receipt = parsed.data;
    if (
      receipt.commandIdentitySha256 !== expected.commandIdentitySha256 ||
      receipt.requestSha256 !== durableRequest.providerRequestSha256 ||
      receipt.operationKind !== command.operationKind ||
      receipt.operationId !== expected.operationId ||
      receipt.idempotencyKey !== preparationInput.idempotencyKey ||
      receipt.providerExpectedVersion !== preparationInput.providerExpectedVersion ||
      receipt.preparedFinancialCommandId !== prepared.preparedCommandId ||
      receipt.preparedAuthoritySha256 !== prepared.authorityContextSha256
    )
      return refuse('RECEIPT_BINDING_MISMATCH');
    stableRelease();
    return Object.freeze({
      commandId: receipt.commandId,
      preparedCommandId: receipt.preparedFinancialCommandId,
      operationId: receipt.operationId,
      requestState: 'REQUESTED' as const,
      requestedAt: receipt.recordedAt,
      idempotencyReplayed: receipt.idempotencyReplayed,
    });
  }
}

export function authorizedUniversalV1FinancialApiRelease(): FinancialProviderCommandReleaseEvidence {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
  const evidence = readReleaseManifest();
  const digest = releaseManifestDigest(manifest);
  if (evidence.digest !== digest || !isAuthenticatedReleaseManifest(evidence, process.env))
    return refuse('AUTHENTICATED_RELEASE_REQUIRED');
  return Object.freeze({
    manifestDigest: digest,
    releaseId: manifest.releaseId,
    revision: manifest.components.backend.revision,
    environment: manifest.environment,
    authenticationStatus: 'VERIFIED' as const,
  });
}

export function createUniversalV1FinancialRequestService(): UniversalV1FinancialRequestService;
export function createUniversalV1FinancialRequestService(
  ...callerArguments: readonly unknown[]
): UniversalV1FinancialRequestService {
  if (callerArguments.length) return refuse('CALLER_SHAPED_FACTORY_INPUT');
  authorizedUniversalV1FinancialApiRelease();
  return new UniversalV1FinancialRequestService(
    new PostgresUniversalV1PreparedFinancialCommandAuthority(),
    new PostgresFinancialProviderCommandJournal(),
    authorizedUniversalV1FinancialApiRelease
  );
}
