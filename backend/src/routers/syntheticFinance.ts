import { TRPCError } from '@trpc/server';

import { enqueueSyntheticFinancialEvent } from '../jobs/synthetic-financial-worker.js';
import {
  SyntheticFinancialAuthorityError,
  syntheticFinancialCommandAuthority,
} from '../services/payment/SyntheticFinancialCommandAuthority.js';
import {
  refusePublicSyntheticReconciliation,
  syntheticFinancialEventCommandSchema,
  syntheticProviderAccountEstablishmentCommandSchema,
  syntheticProviderAccountStateCommandSchema,
  syntheticProviderOnboardingCommandSchema,
  syntheticReconciliationCommandSchema,
  signedSyntheticWebhookIngressSchema,
} from '../services/payment/SyntheticFinancialCommandSchemas.js';
import { ProviderEventInboxError } from '../services/payment/ProviderEventInbox.js';
import {
  authenticateAndRecordSyntheticFinancialWebhook,
  SyntheticFinancialWebhookIngressError,
} from '../services/payment/SyntheticFinancialWebhookInbox.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type ExecuteUniversalV1FinancialEventCommand,
} from '../services/payment/UniversalV1FinancialApplicationService.js';
import { PostgresUniversalV1FakeProviderAccountRepository } from '../services/payment/UniversalV1FakeProviderAccountRepository.js';
import { protectedProcedure, router } from '../trpc.js';

function routeError(error: unknown): never {
  if (error instanceof SyntheticFinancialWebhookIngressError) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid synthetic webhook payload.',
    });
  }
  if (error instanceof ProviderEventInboxError) {
    if (error.reason === 'PERSISTENCE_INCOMPLETE') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Synthetic webhook evidence is temporarily unavailable.',
      });
    }
    if (error.reason === 'EVENT_CONFLICT' || error.reason === 'IDEMPOTENCY_CONFLICT') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Synthetic webhook evidence conflicts with a prior receipt.',
      });
    }
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Synthetic webhook evidence failed its ingress contract.',
    });
  }
  if (
    error instanceof SyntheticFinancialAuthorityError ||
    (error instanceof Error && error.message.startsWith('NONPRODUCTION_FAKE_FINANCE_REFUSED:'))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Fake-value finance is unavailable for this actor or environment.',
    });
  }
  if (
    error instanceof Error &&
    (error.message.startsWith('UNIVERSAL_FINANCE_') ||
      error.message.startsWith('UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_') ||
      error.message.startsWith('FAKE_FINANCIAL_'))
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Universal V1 financial command failed its lifecycle contract.',
    });
  }
  throw error;
}

/**
 * Canonical Universal V1 financial command boundary.
 *
 * Generic event calls are limited to the pre-WorkOrder preparation,
 * authorization, and secure lane. Terminal events and reconciliation remain
 * internal to the exact-intent fulfillment application. The provider-neutral
 * application service permits only deterministic fake value in local, preview,
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
          input.taskId
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

  reconcile: protectedProcedure.input(syntheticReconciliationCommandSchema).mutation(() => {
    try {
      return refusePublicSyntheticReconciliation();
    } catch (error) {
      return routeError(error);
    }
  }),

  enqueueReconciliation: protectedProcedure
    .input(syntheticReconciliationCommandSchema)
    .mutation(() => {
      try {
        return refusePublicSyntheticReconciliation();
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
          recordedBy: ctx.user.id,
        });
      } catch (error) {
        return routeError(error);
      }
    }),

  establishSelfAccount: protectedProcedure
    .input(syntheticProviderAccountEstablishmentCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await syntheticFinancialCommandAuthority.assertProviderAccountAuthority(
          ctx.user.id,
          input.providerOrganizationId ?? null
        );
        const service = createUniversalV1FakeFinancialApplicationService();
        const providerId = input.providerOrganizationId ?? ctx.user.id;
        const onboard = await service.onboardProvider({
          providerKind: input.providerKind,
          operationId: input.onboardOperationId,
          idempotencyKey: input.onboardIdempotencyKey,
          providerExpectedVersion: input.providerExpectedVersion,
          providerId,
          ...(input.onboardScenario === undefined ? {} : { scenario: input.onboardScenario }),
          recordedBy: ctx.user.id,
        });
        const refresh = await service.refreshProviderAccountState({
          providerKind: input.providerKind,
          operationId: input.refreshOperationId,
          idempotencyKey: input.refreshIdempotencyKey,
          providerExpectedVersion: input.providerExpectedVersion,
          providerId,
          providerAccountReference: onboard.externalReference,
          ...(input.refreshScenario === undefined ? {} : { scenario: input.refreshScenario }),
          recordedBy: ctx.user.id,
        });
        return await new PostgresUniversalV1FakeProviderAccountRepository().materializeFromDurableEvidence(
          {
            providerSubject:
              input.providerOrganizationId === undefined
                ? { kind: 'USER', userId: ctx.user.id }
                : {
                    kind: 'ORGANIZATION',
                    organizationId: input.providerOrganizationId,
                  },
            recordedBy: ctx.user.id,
            onboard: onboard.durableFakeEvidence,
            refresh: refresh.durableFakeEvidence,
          }
        );
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
          recordedBy: ctx.user.id,
        });
      } catch (error) {
        return routeError(error);
      }
    }),

  ingestWebhook: protectedProcedure
    .input(signedSyntheticWebhookIngressSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const authenticated = await authenticateAndRecordSyntheticFinancialWebhook(input);
        const command = authenticated.command;
        await syntheticFinancialCommandAuthority.assertTaskParticipant(
          ctx.user.id,
          command.taskDraftId,
          command.taskId
        );
        await syntheticFinancialCommandAuthority.assertWebhookOperationBoundary(
          command.taskDraftId,
          command.taskId,
          command.operationId
        );
        const service = createUniversalV1FakeFinancialApplicationService();
        return await service.ingestWebhook({
          providerKind: command.providerKind,
          operationId: command.operationId,
          idempotencyKey: authenticated.normalizationIdempotencyKey,
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
