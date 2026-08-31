import {
  AdvanceUniversalV1WorkOrderExecutionPublicSchema,
  GetUniversalV1WorkOrderExecutionStatePublicSchema,
  type AdvanceUniversalV1WorkOrderExecutionPublic,
  type GetUniversalV1WorkOrderExecutionStatePublic,
  type UniversalV1ExecutionAdvanceResult,
  UniversalV1ExecutionError,
  type UniversalV1ExecutionStateResult,
  universalV1ExecutionRequestSha256,
} from './UniversalV1ExecutionContracts.js';
import { PostgresUniversalV1ExecutionRepository } from './UniversalV1ExecutionPostgresRepository.js';

const MAX_COMMAND_CLOCK_SKEW_MS = 5 * 60_000;

export interface UniversalV1ExecutionRepository {
  getWorkOrderExecutionState(
    actorUserId: string,
    workOrderId: string
  ): Promise<UniversalV1ExecutionStateResult>;

  advanceWorkOrderExecution(
    actorUserId: string,
    input: AdvanceUniversalV1WorkOrderExecutionPublic,
    requestSha256: string
  ): Promise<UniversalV1ExecutionAdvanceResult>;
}

function assertFresh(clientTimestamp: string, now: number): void {
  const parsed = Date.parse(clientTimestamp);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_COMMAND_CLOCK_SKEW_MS) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_REQUEST_STALE',
      'The execution request timestamp is outside the allowed window.'
    );
  }
}

/**
 * Public application boundary for immutable Universal V1 execution-state facts.
 *
 * Wire actions are parsed and mapped on the server. Neither operation can create
 * a hard assignment or invoke a financial provider.
 */
export class UniversalV1ExecutionApplication {
  constructor(
    private readonly repository: UniversalV1ExecutionRepository = new PostgresUniversalV1ExecutionRepository(),
    private readonly now: () => number = Date.now
  ) {}

  getWorkOrderExecutionState(
    actorUserId: string,
    rawInput: GetUniversalV1WorkOrderExecutionStatePublic
  ): Promise<UniversalV1ExecutionStateResult> {
    const input = GetUniversalV1WorkOrderExecutionStatePublicSchema.parse(rawInput);
    return this.repository.getWorkOrderExecutionState(actorUserId, input.work_order_id);
  }

  advanceWorkOrderExecution(
    actorUserId: string,
    rawInput: AdvanceUniversalV1WorkOrderExecutionPublic
  ): Promise<UniversalV1ExecutionAdvanceResult> {
    const input = AdvanceUniversalV1WorkOrderExecutionPublicSchema.parse(rawInput);
    assertFresh(input.client_ts, this.now());
    return this.repository.advanceWorkOrderExecution(
      actorUserId,
      input,
      universalV1ExecutionRequestSha256(actorUserId, input)
    );
  }
}
