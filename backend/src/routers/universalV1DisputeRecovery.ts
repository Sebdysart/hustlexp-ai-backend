import { z } from 'zod';

import { operationsAdminProcedure, protectedProcedure, router, Schemas } from '../trpc.js';
import {
  getUniversalV1DisputeForOperator,
  getUniversalV1DisputeForParticipant,
  listUniversalV1DisputesForParticipant,
} from '../services/UniversalV1DisputeReadModel.js';
import {
  addUniversalV1DisputeEvidence,
  beginUniversalV1DisputeReview,
  openUniversalV1Dispute,
  proposeUniversalV1Recovery,
  recordUniversalV1RecoveryApproval,
  universalV1DisputeEvidenceKinds,
  universalV1DisputeIncidentKinds,
  universalV1RecoveryKinds,
} from '../services/UniversalV1DisputeRecoveryService.js';

const exactVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const evidenceDigest = z.string().regex(/^(?!0{64})[a-f0-9]{64}$/u);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u);

/**
 * Universal V1 incident/recovery facts. Participant routes are authenticated
 * and PostgreSQL derives CUSTOMER/PROVIDER authority from the exact Work Order.
 * Operator routes additionally require fresh MFA plus Operations RBAC, while
 * PostgreSQL rechecks dispute-resolution authority. No route can finalize a
 * resolution, edit lifecycle state, or create a provider/money effect.
 */
export const universalV1DisputeRecoveryRouter = router({
  open: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      expectedTaskVersion: exactVersion,
      workOrderId: Schemas.uuid,
      expectedWorkOrderVersion: exactVersion,
      completionFactId: Schemas.uuid,
      expectedCompletionVersion: exactVersion,
      expectedExecutionVersion: exactVersion,
      incidentKind: z.enum(universalV1DisputeIncidentKinds),
      evidenceDigest,
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => openUniversalV1Dispute(ctx, input)),

  addEvidence: protectedProcedure
    .input(z.object({
      disputeId: Schemas.uuid,
      expectedDisputeVersion: exactVersion,
      evidenceKind: z.enum(universalV1DisputeEvidenceKinds),
      evidenceDigest,
      contentType: z.string().trim().min(3).max(120),
      byteSize: z.number().int().min(1).max(104_857_600),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => addUniversalV1DisputeEvidence(ctx, input)),

  get: protectedProcedure
    .input(z.object({ disputeId: Schemas.uuid }))
    .query(({ ctx, input }) => getUniversalV1DisputeForParticipant(ctx, input.disputeId)),

  listMine: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(10_000).default(0),
    }).optional())
    .query(({ ctx, input }) => listUniversalV1DisputesForParticipant(
      ctx,
      input?.limit ?? 50,
      input?.offset ?? 0,
    )),

  beginReview: operationsAdminProcedure
    .input(z.object({
      disputeId: Schemas.uuid,
      expectedDisputeVersion: exactVersion,
      evidenceDigest,
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => beginUniversalV1DisputeReview(ctx, input)),

  proposeRecovery: operationsAdminProcedure
    .input(z.object({
      disputeId: Schemas.uuid,
      expectedDisputeVersion: exactVersion,
      recoveryKind: z.enum(universalV1RecoveryKinds),
      evidenceDigest,
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => proposeUniversalV1Recovery(ctx, input)),

  recordIndependentApproval: operationsAdminProcedure
    .input(z.object({
      recoveryIntentId: Schemas.uuid,
      expectedDisputeVersion: exactVersion,
      evidenceDigest,
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => recordUniversalV1RecoveryApproval(ctx, input)),

  getForOperator: operationsAdminProcedure
    .input(z.object({ disputeId: Schemas.uuid }))
    .query(({ ctx, input }) => getUniversalV1DisputeForOperator(ctx, input.disputeId)),
});

export type UniversalV1DisputeRecoveryRouter = typeof universalV1DisputeRecoveryRouter;
