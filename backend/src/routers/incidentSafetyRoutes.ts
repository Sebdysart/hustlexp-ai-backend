import { z } from 'zod';
import { protectedProcedure, safetyAdminProcedure, Schemas } from '../trpc.js';
import { TaskSafetyCheckinService } from '../services/TaskSafetyCheckinService.js';
import { TaskSafetyLocationService } from '../services/TaskSafetyLocationService.js';
import {
  getMySafetyReports,
  reportSafety,
} from '../services/IncidentSafetyReportService.js';
import {
  acknowledgeSafety,
  getSafetyCaseForAdmin,
  listSafetyCases,
  recordSafetyContact,
  resolveSafety,
  safetyResolutionCodes,
} from '../services/IncidentSafetyAdminService.js';
import { safetyReportInput } from './incidentSafetyPolicy.js';

export const incidentSafetyProcedures = {
  startSafetyCheckin: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
      idempotencyKey: z.string().uuid(),
    }))
    .mutation(({ ctx, input }) => TaskSafetyCheckinService.start({
      taskId: input.taskId,
      participantUserId: ctx.user!.id,
      durationMinutes: input.durationMinutes,
      idempotencyKey: input.idempotencyKey,
    })),

  getMySafetyCheckins: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(({ ctx, input }) => TaskSafetyCheckinService.list(input.taskId, ctx.user!.id)),

  confirmSafetyCheckin: protectedProcedure
    .input(z.object({ checkinId: Schemas.uuid }))
    .mutation(({ ctx, input }) => TaskSafetyCheckinService.confirm(
      input.checkinId,
      ctx.user!.id,
    )),

  reportSafety: protectedProcedure
    .input(safetyReportInput)
    .mutation(({ ctx, input }) => reportSafety(input, ctx.user!.id)),

  getSafetyLocation: safetyAdminProcedure
    .input(z.object({
      incidentId: Schemas.uuid,
      purpose: z.string().trim().min(10).max(500),
    }))
    .query(({ ctx, input }) => TaskSafetyLocationService.getForAdmin({
      incidentId: input.incidentId,
      adminUserId: ctx.user!.id,
      purpose: input.purpose,
    })),

  getMySafetyReports: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(({ ctx, input }) => getMySafetyReports(input.taskId, ctx.user!.id)),

  listSafetyCases: safetyAdminProcedure
    .input(z.object({
      includeResolved: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(({ ctx, input }) => listSafetyCases(input, ctx.user!.id)),

  getSafetyCaseForAdmin: safetyAdminProcedure
    .input(z.object({
      incidentId: Schemas.uuid,
      purpose: z.string().trim().min(10).max(500),
    }))
    .query(({ ctx, input }) => getSafetyCaseForAdmin(
      input.incidentId,
      input.purpose,
      ctx.user!.id,
    )),

  acknowledgeSafety: safetyAdminProcedure
    .input(z.object({
      incidentId: Schemas.uuid,
      publicMessage: z.string().trim().min(1).max(500),
    }))
    .mutation(({ ctx, input }) => acknowledgeSafety(
      input.incidentId,
      input.publicMessage,
      ctx.user!.id,
    )),

  resolveSafety: safetyAdminProcedure
    .input(z.object({
      incidentId: Schemas.uuid,
      idempotencyKey: z.string().uuid(),
      resolutionCode: z.enum(safetyResolutionCodes),
      publicMessage: z.string().trim().min(10).max(500),
    }))
    .mutation(({ ctx, input }) => resolveSafety(input, ctx.user!.id)),

  recordSafetyContact: safetyAdminProcedure
    .input(z.object({
      incidentId: Schemas.uuid,
      providerEventId: z.string().trim().min(8).max(255).regex(/^[A-Za-z0-9:_-]+$/),
      eventType: z.enum(['contact_attempted', 'contact_delivered', 'contact_failed']),
      channel: z.enum(['call', 'text']),
      publicMessage: z.string().trim().min(1).max(500),
      occurredAt: z.string().datetime(),
    }))
    .mutation(({ ctx, input }) => recordSafetyContact(input, ctx.user!.id)),
};
