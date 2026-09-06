import { TRPCError } from '@trpc/server';
import { FakeFinancialProgressPayloadSchema } from '../auth/financial-progress-command-contract.js';

import { createUniversalV1FinancialRequestService } from '../services/payment/UniversalV1FinancialRequestService.js';
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
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
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
 * request service permits only deterministic fake value in local, preview,
 * or staging. Both event route names return a durable REQUESTED receipt;
 * execution and lifecycle recording belong to the admitted worker.
 * Legacy processor-specific routers remain compatibility/recovery
 * surfaces and are not imported here.
 */
export const universalFinanceRouter = router({
  requestProgress: protectedProcedure
    .input(FakeFinancialProgressPayloadSchema)
    .query(async ({ ctx, input }) => {
      let progress;
      try {
        progress = await createUniversalV1FinancialRequestService().readProgress(
          input.commandId,
          ctx.user.id,
          ctx.actorAttestation
        );
      } catch {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Financial request progress is temporarily unavailable.',
        });
      }
      if (progress === null)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Financial request not found.',
        });
      return progress;
    }),
  executeEvent: protectedProcedure
    .input(syntheticFinancialEventCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createUniversalV1FinancialRequestService().requestFinancialEvent(
          {
            ...input,
            recordedBy: ctx.user.id,
          } as ExecuteUniversalV1FinancialEventCommand,
          ctx.actorAttestation
        );
      } catch (error) {
        return routeError(error);
      }
    }),

  enqueueEvent: protectedProcedure
    .input(syntheticFinancialEventCommandSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createUniversalV1FinancialRequestService().requestFinancialEvent(
          { ...input, recordedBy: ctx.user.id } as ExecuteUniversalV1FinancialEventCommand,
          ctx.actorAttestation
        );
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
        const service = await createUniversalV1FakeFinancialApplicationService();
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
        const service = await createUniversalV1FakeFinancialApplicationService();
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
        const service = await createUniversalV1FakeFinancialApplicationService();
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
    .mutation(async ({ input }) => {
      try {
        assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
        const authenticated = await authenticateAndRecordSyntheticFinancialWebhook(input);
        const observation = authenticated.observation;
        return {
          received: true as const,
          queued: true as const,
          providerKind: observation.providerKind,
          operationId: observation.operationId,
          observationId: authenticated.receipt.observationId,
          receiptId: authenticated.receipt.receiptId,
          observationReplayed: authenticated.receipt.observationReplayed,
          idempotencyReplayed: authenticated.receipt.idempotencyReplayed,
        };
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
