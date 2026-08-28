import { z } from 'zod';
import { adminOrEngineBridgeProcedure, posterProcedure, Schemas } from '../trpc.js';
import { createControlledTemplate } from '../services/ControlledRecurringPolicyService.js';
import {
  generateControlledRecurringOccurrence,
  listControlledRecurringTemplates,
  recordControlledRecurringSafeguard,
  recoverControlledRecurringTemplate,
} from '../services/RecurringWorkService.js';
import { controlledResult, controlledTemplateInput } from './recurringTaskSchemas.js';

function safeguardEvidence(input: {
  amountCents?: number;
  projectedTotalCents?: number;
  validUntil?: string;
  referenceId?: string;
  note?: string;
}) {
  return {
    ...(input.amountCents !== undefined ? { amount_cents: input.amountCents } : {}),
    ...(input.projectedTotalCents !== undefined
      ? { projected_total_cents: input.projectedTotalCents }
      : {}),
    ...(input.validUntil ? { valid_until: input.validUntil } : {}),
    ...(input.referenceId ? { reference_id: input.referenceId } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

export const recurringControlledProcedures = {
  createControlled: posterProcedure
    .input(controlledTemplateInput)
    .mutation(async ({ ctx, input }) => controlledResult(
      await createControlledTemplate(input, ctx.user.id),
    )),

  listControlled: posterProcedure
    .input(z.object({}).strict().optional())
    .query(async ({ ctx }) => controlledResult(
      await listControlledRecurringTemplates(ctx.user.id),
    )),

  generateControlled: adminOrEngineBridgeProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      lookaheadHours: z.number().int().min(1).max(24).default(24).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => controlledResult(
      await generateControlledRecurringOccurrence({
        seriesId: input.seriesId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        lookaheadHours: input.lookaheadHours ?? 24,
      }),
    )),

  recordControlledSafeguard: adminOrEngineBridgeProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      signal: z.enum([
        'PRICE_CORRIDOR_BREACH',
        'PROVIDER_FAILURE',
        'BUDGET_SPEND',
        'CREDENTIAL_EXPIRY',
        'LOCATION_CLOSED',
        'DISPUTE_OPENED',
        'MATERIAL_SCOPE_CHANGE',
        'FULFILLMENT_FAILURE',
      ]),
      evidence: z.object({
        amountCents: z.number().int().nonnegative().max(999_999_900).optional(),
        projectedTotalCents: z.number().int().positive().max(99_999_900).optional(),
        validUntil: z.string().datetime().optional(),
        referenceId: z.string().trim().min(1).max(128).optional(),
        note: z.string().trim().min(1).max(1000).optional(),
      }).strict(),
    }).strict())
    .mutation(async ({ ctx, input }) => controlledResult(
      await recordControlledRecurringSafeguard({
        seriesId: input.seriesId,
        signal: input.signal,
        evidence: safeguardEvidence(input.evidence),
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
      }),
    )),

  recoverControlled: adminOrEngineBridgeProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      reason: z.string().trim().min(10).max(1000),
      evidence: z.object({
        conditionsResolved: z.literal(true),
        referenceId: z.string().trim().min(1).max(128),
        note: z.string().trim().max(1000).optional(),
      }).strict(),
    }).strict())
    .mutation(async ({ ctx, input }) => controlledResult(
      await recoverControlledRecurringTemplate({
        seriesId: input.seriesId,
        actorId: ctx.user?.id ?? ctx.engineBridgeActorId!,
        reason: input.reason,
        evidence: {
          conditions_resolved: true,
          reference_id: input.evidence.referenceId,
          ...(input.evidence.note ? { note: input.evidence.note } : {}),
        },
      }),
    )),
};
