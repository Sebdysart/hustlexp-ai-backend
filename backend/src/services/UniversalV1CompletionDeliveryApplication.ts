import {
  AuthenticatedCompletionDeliverySinkSchema,
  type AuthenticatedCompletionDeliverySink,
  UniversalV1CompletionDeliveryReceiptWebhookSchema,
  type UniversalV1CompletionDeliveryReceiptWebhook,
  UniversalV1CompletionDeliveryError,
  type UniversalV1CompletionDeliveryReceiptResult,
} from './UniversalV1CompletionDeliveryContracts.js';
import { PostgresUniversalV1CompletionDeliveryRepository } from './UniversalV1CompletionDeliveryPostgresRepository.js';

export interface UniversalV1CompletionDeliveryCommandHandler {
  recordAuthenticatedReceipt(
    sink: AuthenticatedCompletionDeliverySink,
    input: UniversalV1CompletionDeliveryReceiptWebhook
  ): Promise<UniversalV1CompletionDeliveryReceiptResult>;
}

export class UniversalV1CompletionDeliveryApplication implements UniversalV1CompletionDeliveryCommandHandler {
  constructor(
    private readonly repository = new PostgresUniversalV1CompletionDeliveryRepository()
  ) {}

  recordAuthenticatedReceipt(
    rawSink: AuthenticatedCompletionDeliverySink,
    rawInput: UniversalV1CompletionDeliveryReceiptWebhook
  ): Promise<UniversalV1CompletionDeliveryReceiptResult> {
    const sink = AuthenticatedCompletionDeliverySinkSchema.safeParse(rawSink);
    if (!sink.success) {
      throw new UniversalV1CompletionDeliveryError(
        'COMPLETION_DELIVERY_SERVICE_IDENTITY_INVALID',
        'The authenticated completion-delivery service identity is invalid.'
      );
    }
    const input = UniversalV1CompletionDeliveryReceiptWebhookSchema.parse(rawInput);
    return this.repository.record(sink.data, input);
  }
}
