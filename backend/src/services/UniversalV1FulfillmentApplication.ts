import {
  type CompleteFakeFinancialLifecyclePublic,
  type DecideCompletionPublic,
  type RecordExecutionEvidencePublic,
  type SubmitCompletionEvidencePublic,
  UniversalV1FulfillmentError,
} from './UniversalV1FulfillmentContracts.js';
import { PostgresUniversalV1FulfillmentRepository } from './UniversalV1FulfillmentPostgresRepository.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type UniversalV1FakeFinancialApplicationService,
} from './payment/UniversalV1FinancialApplicationService.js';

type FakeFinanceFactory = () => UniversalV1FakeFinancialApplicationService;

function assertCurrentRequest(clientTimestamp: string): void {
  const timestamp = Date.parse(clientTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_REQUEST_STALE',
      'The fulfillment request timestamp is outside the allowed window.'
    );
  }
}

/**
 * Canonical continuation from an immutable, unassigned Universal V1 Work Order.
 *
 * This service never writes tasks.worker_id, never resolves a processor-specific
 * adapter, and never creates production money. The terminal financial command
 * first commits its business-authority read, then uses the independent,
 * journaled fake-finance coordinator. Provider I/O is never entered from a
 * caller-owned business transaction.
 */
export class UniversalV1FulfillmentApplication {
  constructor(
    private readonly repository = new PostgresUniversalV1FulfillmentRepository(),
    private readonly createFinance: FakeFinanceFactory = () =>
      createUniversalV1FakeFinancialApplicationService()
  ) {}

  recordExecutionEvidence(actorId: string, input: RecordExecutionEvidencePublic) {
    assertCurrentRequest(input.client_ts);
    return this.repository.recordExecutionEvidence(actorId, input);
  }

  submitCompletionEvidence(actorId: string, input: SubmitCompletionEvidencePublic) {
    assertCurrentRequest(input.client_ts);
    return this.repository.submitCompletionEvidence(actorId, input);
  }

  decideCompletion(actorId: string, input: DecideCompletionPublic) {
    assertCurrentRequest(input.client_ts);
    return this.repository.decideCompletion(actorId, input);
  }

  completeFakeFinancialLifecycle(actorId: string, input: CompleteFakeFinancialLifecyclePublic) {
    assertCurrentRequest(input.client_ts);
    const finance = this.createFinance();
    return this.repository.completeFakeFinancialLifecycle(actorId, input, finance);
  }
}
