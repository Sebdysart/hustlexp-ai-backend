import { db } from '../db.js';
import type {
  AcceptUniversalV1StandardizedQuoteInput,
  PrepareUniversalV1FakePaymentMethodInput,
  PrepareUniversalV1StandardizedQuoteInput,
} from './UniversalV1StandardizedQuoteContracts.js';
import type {
  AcceptUniversalV1StandardizedQuoteCommand,
  PrepareUniversalV1FakePaymentMethodCommand,
  PrepareUniversalV1StandardizedQuoteCommand,
  UniversalV1StandardizedQuoteRepository,
} from './UniversalV1StandardizedQuoteApplication.js';
import { UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore } from './UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore.js';
import { UniversalV1StandardizedQuotePostgresQuoteStore } from './UniversalV1StandardizedQuotePostgresQuoteStore.js';
import type { StandardizedQuoteDatabase } from './UniversalV1StandardizedQuotePostgresSupport.js';

export class UniversalV1StandardizedQuotePostgresRepository
  implements UniversalV1StandardizedQuoteRepository
{
  private readonly quoteStore: UniversalV1StandardizedQuotePostgresQuoteStore;
  private readonly acceptanceReadinessStore: UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore;

  constructor(database: StandardizedQuoteDatabase = db) {
    this.quoteStore = new UniversalV1StandardizedQuotePostgresQuoteStore(database);
    this.acceptanceReadinessStore =
      new UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore(database);
  }

  findQuoteReplay(
    actorUserId: string,
    input: PrepareUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ) {
    return this.quoteStore.findQuoteReplay(actorUserId, input, requestSha256);
  }

  prepareQuote(command: PrepareUniversalV1StandardizedQuoteCommand) {
    return this.quoteStore.prepareQuote(command);
  }

  getCurrent(actorUserId: string, input: { taskDraftId: string }) {
    return this.quoteStore.getCurrent(actorUserId, input);
  }

  findAcceptanceReplay(
    actorUserId: string,
    input: AcceptUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ) {
    return this.acceptanceReadinessStore.findAcceptanceReplay(
      actorUserId,
      input,
      requestSha256
    );
  }

  acceptQuote(command: AcceptUniversalV1StandardizedQuoteCommand) {
    return this.acceptanceReadinessStore.acceptQuote(command);
  }

  findFakePaymentMethodReplay(
    actorUserId: string,
    input: PrepareUniversalV1FakePaymentMethodInput,
    requestSha256: string
  ) {
    return this.acceptanceReadinessStore.findFakePaymentMethodReplay(
      actorUserId,
      input,
      requestSha256
    );
  }

  prepareFakePaymentMethod(command: PrepareUniversalV1FakePaymentMethodCommand) {
    return this.acceptanceReadinessStore.prepareFakePaymentMethod(command);
  }
}
