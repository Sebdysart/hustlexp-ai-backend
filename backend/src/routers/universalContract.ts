import { TRPCError } from '@trpc/server';

import {
  AcceptUniversalV1ProviderEstimatePublicSchema,
  IssueUniversalV1ProviderEstimateInvitationPublicSchema,
  SubmitUniversalV1ProviderEstimatePublicSchema,
  UniversalV1EstimateApplication,
  UniversalV1EstimatePublicError,
} from '../services/UniversalV1EstimateApplication.js';
import {
  UniversalV1EstimateError,
  UniversalV1EstimateService,
  type UniversalV1EstimateErrorCode,
} from '../services/UniversalV1EstimateService.js';
import { PostgresUniversalV1EstimateRepository } from '../services/UniversalV1EstimatePostgresRepository.js';
import { PostgresUniversalV1EstimatePublicFactReader } from '../services/UniversalV1EstimatePublicFacts.js';
import { operationsStepUpProcedure, protectedProcedure, router } from '../trpc.js';
import type { User } from '../types.js';
import { UniversalV1WorkOrderApplication } from '../services/UniversalV1WorkOrderApplication.js';
import {
  ExpressUniversalV1ProviderInterestPublicSchema,
  MaterializeUniversalV1WorkOrderPublicSchema,
  PlaceUniversalV1ConditionalHoldPublicSchema,
} from '../services/UniversalV1WorkOrderContracts.js';
import { UniversalV1WorkOrderError } from '../services/UniversalV1WorkOrderContracts.js';
import { UniversalV1FulfillmentApplication } from '../services/UniversalV1FulfillmentApplication.js';
import {
  CompleteUniversalV1FakeFinancialLifecyclePublicSchema,
  DecideUniversalV1CompletionPublicSchema,
  RecordUniversalV1ExecutionEvidencePublicSchema,
  SubmitUniversalV1CompletionEvidencePublicSchema,
  UniversalV1FulfillmentError,
} from '../services/UniversalV1FulfillmentContracts.js';
import { UniversalV1ExecutionApplication } from '../services/UniversalV1ExecutionApplication.js';
import {
  AdvanceUniversalV1WorkOrderExecutionPublicSchema,
  GetUniversalV1WorkOrderExecutionStatePublicSchema,
  UniversalV1ExecutionError,
} from '../services/UniversalV1ExecutionContracts.js';
import { UniversalV1ChangeOrderApplication } from '../services/UniversalV1ChangeOrderApplication.js';
import {
  AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema,
  DecideUniversalV1ChangeOrderPublicSchema,
  ProposeUniversalV1ChangeOrderPublicSchema,
  UniversalV1ChangeOrderError,
} from '../services/UniversalV1ChangeOrderContracts.js';

type UniversalV1EstimateApplicationPort = Pick<
  UniversalV1EstimateApplication,
  'acceptProviderEstimate' | 'issueProviderEstimateInvitation' | 'submitProviderEstimate'
>;

/**
 * Estimate participation is not coupled to the account's current UI mode.
 * Both operations require a fully classified adult and a current ACTIVE
 * account; `protectedProcedure` separately handles authentication, bans, and
 * suspended/deleted accounts.
 */
export function assertUniversalV1EstimateActor(user: User): void {
  if (user.account_status !== 'ACTIVE') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'An active account is required for estimate actions.',
    });
  }
  if (user.is_minor !== false) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Complete an adult profile before using estimates.',
    });
  }
}

function domainErrorCode(code: UniversalV1EstimateErrorCode): {
  code: TRPCError['code'];
  message: string;
} {
  switch (code) {
    case 'ESTIMATE_INVITATION_REQUIRED':
    case 'ESTIMATE_INVITATION_NOT_FOUND':
    case 'ESTIMATE_ACCEPTANCE_NOT_ALLOWED':
      return { code: 'NOT_FOUND', message: 'The estimate is unavailable.' };
    case 'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED':
    case 'ESTIMATE_PROVIDER_NOT_AUTHORIZED':
    case 'ESTIMATE_TRADE_QUALIFICATION_REQUIRED':
      return {
        code: 'FORBIDDEN',
        message: 'The estimate action is unavailable for this provider.',
      };
    case 'ESTIMATE_ACCEPTANCE_IDEMPOTENCY_CONFLICT':
    case 'ESTIMATE_ACCEPTANCE_VERSION_CONFLICT':
    case 'ESTIMATE_IDEMPOTENCY_CONFLICT':
    case 'ESTIMATE_INVITATION_ALREADY_ISSUED':
    case 'ESTIMATE_INVITATION_IDEMPOTENCY_CONFLICT':
    case 'ESTIMATE_INVITATION_VERSION_CONFLICT':
    case 'ESTIMATE_QUOTE_VERSION_CONFLICT':
    case 'ESTIMATE_ROUTE_NOT_ACTIVE':
    case 'ESTIMATE_WORK_CATEGORY_CONFLICT':
      return {
        code: 'CONFLICT',
        message: 'The estimate changed. Refresh and try again.',
      };
    case 'ESTIMATE_REGION_POLICY_REFUSED':
    case 'ESTIMATE_INVITATION_EXPIRED':
    case 'ESTIMATE_INVITATION_NOT_ALLOWED':
    case 'ESTIMATE_ROUTE_NOT_ESTIMATE_REQUIRED':
      return {
        code: 'PRECONDITION_FAILED',
        message: 'The estimate action is not currently available.',
      };
    case 'ESTIMATE_TASK_MATERIALIZATION_FAILED':
    case 'ESTIMATE_INVITATION_CONTEXT_INVALID':
    case 'ESTIMATE_INVITATION_CREATE_FAILED':
      return {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to process the estimate command.',
      };
  }
}

export function universalV1EstimateRouteError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof UniversalV1EstimatePublicError) {
    switch (error.code) {
      case 'ESTIMATE_PUBLIC_NOT_FOUND':
        return new TRPCError({ code: 'NOT_FOUND', message: 'The estimate is unavailable.' });
      case 'ESTIMATE_PUBLIC_REQUEST_STALE':
        return new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The estimate request timestamp is outside the allowed window.',
        });
      case 'ESTIMATE_PUBLIC_VERSION_CONFLICT':
        return new TRPCError({
          code: 'CONFLICT',
          message: 'The estimate changed. Refresh and try again.',
        });
      case 'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE':
        return new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to process the estimate command.',
        });
    }
  }
  if (error instanceof UniversalV1EstimateError) {
    return new TRPCError(domainErrorCode(error.code));
  }
  if (error instanceof UniversalV1WorkOrderError) {
    switch (error.code) {
      case 'WORK_ORDER_CONTEXT_UNAVAILABLE':
      case 'WORK_ORDER_AUTHORITY_REVOKED':
        return new TRPCError({
          code: 'NOT_FOUND',
          message: 'The Work Order action is unavailable.',
        });
      case 'WORK_ORDER_REQUEST_STALE':
        return new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The Work Order request timestamp is outside the allowed window.',
        });
      case 'WORK_ORDER_VERSION_CONFLICT':
      case 'WORK_ORDER_IDEMPOTENCY_CONFLICT':
        return new TRPCError({
          code: 'CONFLICT',
          message: 'The Work Order changed. Refresh and try again.',
        });
      case 'WORK_ORDER_MATERIALIZATION_FAILED':
        return new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to materialize the Work Order.',
        });
      case 'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN':
        return new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Hard assignment remains unavailable.',
        });
    }
  }
  if (error instanceof UniversalV1FulfillmentError) {
    switch (error.code) {
      case 'FULFILLMENT_CONTEXT_UNAVAILABLE':
      case 'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED':
        return new TRPCError({
          code: 'NOT_FOUND',
          message: 'The Work Order fulfillment action is unavailable.',
        });
      case 'FULFILLMENT_CUSTOMER_AUTHORITY_REQUIRED':
        return new TRPCError({
          code: 'FORBIDDEN',
          message: 'Customer authority is required for this Work Order action.',
        });
      case 'FULFILLMENT_REQUEST_STALE':
        return new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The fulfillment request timestamp is outside the allowed window.',
        });
      case 'FULFILLMENT_VERSION_CONFLICT':
      case 'FULFILLMENT_IDEMPOTENCY_CONFLICT':
      case 'FULFILLMENT_EVIDENCE_STATE_CONFLICT':
      case 'FULFILLMENT_COMPLETION_STATE_CONFLICT':
        return new TRPCError({
          code: 'CONFLICT',
          message: 'The Work Order lifecycle changed. Refresh and try again.',
        });
      case 'FULFILLMENT_INCIDENT_BLOCKED':
      case 'FULFILLMENT_PROVIDER_ACCOUNT_UNAVAILABLE':
      case 'FULFILLMENT_FAKE_FINANCE_ONLY':
      case 'FULFILLMENT_HARD_ASSIGNMENT_FORBIDDEN':
        return new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The Work Order lifecycle action is not currently permitted.',
        });
    }
  }
  if (error instanceof UniversalV1ExecutionError) {
    switch (error.code) {
      case 'EXECUTION_CONTEXT_UNAVAILABLE':
      case 'EXECUTION_PROVIDER_AUTHORITY_REVOKED':
        return new TRPCError({
          code: 'NOT_FOUND',
          message: 'The Work Order execution action is unavailable.',
        });
      case 'EXECUTION_REQUEST_STALE':
        return new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The execution request timestamp is outside the allowed window.',
        });
      case 'EXECUTION_VERSION_CONFLICT':
      case 'EXECUTION_IDEMPOTENCY_CONFLICT':
      case 'EXECUTION_INVALID_TRANSITION':
        return new TRPCError({
          code: 'CONFLICT',
          message: 'The Work Order execution state changed. Refresh and try again.',
        });
      case 'EXECUTION_INCIDENT_BLOCKED':
      case 'EXECUTION_SCOPE_CHANGE_PENDING':
      case 'EXECUTION_HARD_ASSIGNMENT_FORBIDDEN':
        return new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The execution action is not currently permitted.',
        });
    }
  }
  if (error instanceof UniversalV1ChangeOrderError) {
    switch (error.code) {
      case 'CHANGE_ORDER_CONTEXT_UNAVAILABLE':
      case 'CHANGE_ORDER_AUTHORITY_REVOKED':
        return new TRPCError({
          code: 'NOT_FOUND',
          message: 'The Work Order change action is unavailable.',
        });
      case 'CHANGE_ORDER_REQUEST_STALE':
        return new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The change-order request timestamp is outside the allowed window.',
        });
      case 'CHANGE_ORDER_VERSION_CONFLICT':
      case 'CHANGE_ORDER_IDEMPOTENCY_CONFLICT':
      case 'CHANGE_ORDER_STATE_CONFLICT':
        return new TRPCError({
          code: 'CONFLICT',
          message: 'The Work Order change state changed. Refresh and try again.',
        });
      case 'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED':
      case 'CHANGE_ORDER_SCHEDULE_UNSUPPORTED':
      case 'CHANGE_ORDER_FAKE_FINANCE_ONLY':
      case 'CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN':
        return new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The Work Order change is not currently permitted.',
        });
      case 'CHANGE_ORDER_SCOPE_HASH_MISMATCH':
      case 'CHANGE_ORDER_MATERIALIZATION_FAILED':
        return new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to process the Work Order change.',
        });
    }
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Unable to process the Universal V1 command.',
  });
}

export function createUniversalContractRouter(
  application: UniversalV1EstimateApplicationPort,
  workOrders: Pick<
    UniversalV1WorkOrderApplication,
    'expressProviderInterest' | 'placeConditionalHold' | 'secureAndMaterializeFakeWorkOrder'
  > = new UniversalV1WorkOrderApplication(),
  fulfillment: Pick<
    UniversalV1FulfillmentApplication,
    | 'recordExecutionEvidence'
    | 'submitCompletionEvidence'
    | 'decideCompletion'
    | 'completeFakeFinancialLifecycle'
  > = new UniversalV1FulfillmentApplication(),
  execution: Pick<
    UniversalV1ExecutionApplication,
    'getWorkOrderExecutionState' | 'advanceWorkOrderExecution'
  > = new UniversalV1ExecutionApplication(),
  changeOrders: Pick<
    UniversalV1ChangeOrderApplication,
    'proposeChangeOrder' | 'decideChangeOrder' | 'authorizeAndMaterializeFakeChangeOrder'
  > = new UniversalV1ChangeOrderApplication()
) {
  return router({
    issueProviderEstimateInvitation: operationsStepUpProcedure
      .input(IssueUniversalV1ProviderEstimateInvitationPublicSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await application.issueProviderEstimateInvitation(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),

    submitProviderEstimate: protectedProcedure
      .input(SubmitUniversalV1ProviderEstimatePublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await application.submitProviderEstimate(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),

    acceptProviderEstimate: protectedProcedure
      .input(AcceptUniversalV1ProviderEstimatePublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await application.acceptProviderEstimate(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),

    expressProviderInterest: protectedProcedure
      .input(ExpressUniversalV1ProviderInterestPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await workOrders.expressProviderInterest(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    placeConditionalHold: protectedProcedure
      .input(PlaceUniversalV1ConditionalHoldPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await workOrders.placeConditionalHold(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    secureAndMaterializeFakeWorkOrder: protectedProcedure
      .input(MaterializeUniversalV1WorkOrderPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await workOrders.secureAndMaterializeFakeWorkOrder(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    getWorkOrderExecutionState: protectedProcedure
      .input(GetUniversalV1WorkOrderExecutionStatePublicSchema)
      .query(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await execution.getWorkOrderExecutionState(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    advanceWorkOrderExecution: protectedProcedure
      .input(AdvanceUniversalV1WorkOrderExecutionPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await execution.advanceWorkOrderExecution(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    proposeChangeOrder: protectedProcedure
      .input(ProposeUniversalV1ChangeOrderPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await changeOrders.proposeChangeOrder(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    decideChangeOrder: protectedProcedure
      .input(DecideUniversalV1ChangeOrderPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await changeOrders.decideChangeOrder(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    authorizeAndMaterializeFakeChangeOrder: protectedProcedure
      .input(AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await changeOrders.authorizeAndMaterializeFakeChangeOrder(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    recordExecutionEvidence: protectedProcedure
      .input(RecordUniversalV1ExecutionEvidencePublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await fulfillment.recordExecutionEvidence(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    submitCompletionEvidence: protectedProcedure
      .input(SubmitUniversalV1CompletionEvidencePublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await fulfillment.submitCompletionEvidence(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    decideCompletion: protectedProcedure
      .input(DecideUniversalV1CompletionPublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await fulfillment.decideCompletion(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
    completeFakeFinancialLifecycle: protectedProcedure
      .input(CompleteUniversalV1FakeFinancialLifecyclePublicSchema)
      .mutation(async ({ ctx, input }) => {
        assertUniversalV1EstimateActor(ctx.user);
        try {
          return await fulfillment.completeFakeFinancialLifecycle(ctx.user.id, input);
        } catch (error) {
          throw universalV1EstimateRouteError(error);
        }
      }),
  });
}

export function createUniversalV1EstimateApplication(): UniversalV1EstimateApplication {
  return new UniversalV1EstimateApplication(
    new PostgresUniversalV1EstimatePublicFactReader(),
    new UniversalV1EstimateService(new PostgresUniversalV1EstimateRepository())
  );
}

export const universalContractRouter = createUniversalContractRouter(
  createUniversalV1EstimateApplication()
);

export type UniversalContractRouter = ReturnType<typeof createUniversalContractRouter>;
