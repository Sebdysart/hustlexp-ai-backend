import { TRPCError } from '@trpc/server';

import {
  enqueueSyntheticFinancialEvent,
  enqueueSyntheticReconciliation,
} from '../jobs/synthetic-financial-worker.js';
import {
  assertSyntheticFinancialWebhookHmac,
  SyntheticFinancialAuthorityError,
  syntheticFinancialCommandAuthority,
} from '../services/payment/SyntheticFinancialCommandAuthority.js';
import {
  syntheticFinancialEventCommandSchema,
  syntheticProviderAccountStateCommandSchema,
  syntheticProviderOnboardingCommandSchema,
  syntheticReconciliationCommandSchema,
  signedSyntheticWebhookIngressSchema,
  syntheticWebhookIngressCommandSchema,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
  type ExecuteUniversalV1ReconciliationCommand,
} from '../services/payment/UniversalV1FinancialApplicationService.js';
import { protectedProcedure, router } from '../trpc.js';

function routeError(error: unknown): never {
  if (
    error instanceof SyntheticFinancialAuthorityError
    || (error instanceof Error && error.message.startsWith('NONPRODUCTION_FAKE_FINANCE_REFUSED:'))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Fake-value finance is unavailable for this actor or environment.',
    });
  }
  if (
    error instanceof Error
    && (
      error.message.startsWith('UNIVERSAL_FINANCE_')
      || error.message.startsWith('FAKE_FINANCIAL_')
    )
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Universal V1 financial command failed its lifecycle contract.',
    });
  }
  throw error;
}

function parseSignedWebhook(rawBody: string) {
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid synthetic webhook payload.' });
  }
  const parsed = syntheticWebhookIngressCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid synthetic webhook payload.' });
  }
  return parsed.data;
}

/**
 * Canonical Universal V1 financial command boundary.
 *
 * Every command resolves the provider-neutral application service, whose
 * exact-manifest gate permits only deterministic fake value in local, preview,
 * or staging. Legacy processor-specific routers remain compatibility/recovery
 * surfaces and are not imported here.
 */
export const universalFinanceRouter = router({
  executeEvent: protectedProcedure
    .input(syntheticFinancialEventCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createUniversalV1FakeFinancialApplicationService();
        await syntheticFinancialCommandAuthority.assertTaskParticipant(
          ctx.user.id,
          input.taskDraftId,
          input.taskId,
        );
        return await service.executeFinancialEvent({
          ...input,
          recordedBy: ctx.user.id,
        } as ExecuteUniversalV1FinancialEventCommand);
      } catch (error) {
        return routeError(error);
      }
    }),

  enqueueEvent: protectedProcedure
    .input(syntheticFinancialEventCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await enqueueSyntheticFinancialEvent(ctx.user.id, input);
      } catch (error) {
        return routeError(error);
      }
    }),

  reconcile: protectedProcedure
    .input(syntheticReconciliationCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createUniversalV1FakeFinancialApplicationService();
        await syntheticFinancialCommandAuthority.assertWorkOrderParticipant(
          ctx.user.id,
          input.snapshot.workOrderId,
        );
        return await service.reconcile({
          ...input,
          snapshot: {
            ...input.snapshot,
            recordedBy: ctx.user.id,
          },
        } as ExecuteUniversalV1ReconciliationCommand);
      } catch (error) {
        return routeError(error);
      }
    }),

  enqueueReconciliation: protectedProcedure
    .input(syntheticReconciliationCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await enqueueSyntheticReconciliation(ctx.user.id, input);
      } catch (error) {
        return routeError(error);
      }
    }),

  onboardSelf: protectedProcedure
    .input(syntheticProviderOnboardingCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createUniversalV1FakeFinancialApplicationService();
        return await service.onboardProvider({
          ...input,
          providerId: ctx.user.id,
        });
      } catch (error) {
        return routeError(error);
      }
    }),

  refreshProviderAccountState: protectedProcedure
    .input(syntheticProviderAccountStateCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const service = createUniversalV1FakeFinancialApplicationService();
        return await service.refreshProviderAccountState({
          ...input,
          providerId: ctx.user.id,
        });
      } catch (error) {
        return routeError(error);
      }
    }),

  ingestWebhook: protectedProcedure
    .input(signedSyntheticWebhookIngressSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        assertSyntheticFinancialWebhookHmac(input.rawBody, input.signature);
        const command = parseSignedWebhook(input.rawBody);
        await syntheticFinancialCommandAuthority.assertTaskParticipant(
          ctx.user.id,
          command.taskDraftId,
          command.taskId,
        );
        await syntheticFinancialCommandAuthority.assertWebhookOperationBoundary(
          command.taskDraftId,
          command.taskId,
          command.operationId,
        );
        const service = createUniversalV1FakeFinancialApplicationService();
        return await service.ingestWebhook({
          providerKind: command.providerKind,
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          providerExpectedVersion: command.providerExpectedVersion,
          providerEventReference: command.providerEventReference,
          scenario: command.scenario,
          authenticated: true,
        });
      } catch (error) {
        return routeError(error);
      }
    }),
});

/**
 * Compatibility alias for clients that adopted the original nonproduction
 * route name. New clients use `finance`; both names execute the same guarded
 * provider-neutral router.
 */
export const syntheticFinanceRouter = universalFinanceRouter;

export type UniversalFinanceRouter = typeof universalFinanceRouter;
