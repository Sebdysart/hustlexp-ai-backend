import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import { BUSINESS_ROLES } from '../services/BusinessWorkspacePolicy.js';
import {
  createBusinessLocation,
  createBusinessWorkspace,
  listBusinessLocations,
  listBusinessMembers,
  listBusinessWorkspaces,
  setBusinessMemberRole,
  setBusinessMemberRoleByEmail,
} from '../services/BusinessWorkspaceService.js';
import {
  activateBusinessServiceProfile,
  assignBusinessServiceCrew,
  createBusinessServiceProfile,
  decideBusinessApproval,
  listBusinessApprovalQueue,
  listBusinessBudgetPolicies,
  listMyBusinessSpendRequests,
  listBusinessServiceProfiles,
  requestBusinessSpend,
  submitBusinessCredential,
  upsertBusinessBudgetPolicy,
} from '../services/BusinessOperationsService.js';
import {
  createBusinessInvoiceSnapshot,
  createBusinessWorkOrder,
  listBusinessInvoiceSnapshots,
  listBusinessProviderPerformance,
  listBusinessProviderPreferences,
  listBusinessWorkOrders,
  setBusinessProviderPreferenceByEmail,
} from '../services/BusinessExecutionService.js';
import {
  createBusinessRecurringTemplate,
  listBusinessRecurringTemplates,
} from '../services/BusinessRecurringService.js';
import { workspaceErrorCode } from './BusinessWorkspaceRouterErrors.js';

function unwrapWorkspace<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    throw new TRPCError({
      code: workspaceErrorCode(result.error.code),
      message: result.error.message,
    });
  }
  return result.data;
}

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const workspaceCreateInput = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  providerEnabled: z.boolean(),
  clientEnabled: z.boolean(),
  idempotencyKey,
}).strict().refine(
  (input) => input.providerEnabled || input.clientEnabled,
  { message: 'Choose at least one business mode.' },
);

const organizationInput = z.object({ organizationId: uuid }).strict();
const nullableUuid = uuid.nullable();
const moneyCents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stringList = (maximumItems: number, maximumLength: number) => z.array(
  z.string().trim().min(1).max(maximumLength),
).max(maximumItems);

export const businessWorkspaceRouter = router({
  createWorkspace: protectedProcedure
    .input(workspaceCreateInput)
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessWorkspace({
      ...input,
      actorId: ctx.user.id,
    }))),

  listMine: protectedProcedure
    .query(async ({ ctx }) => unwrapWorkspace(await listBusinessWorkspaces(ctx.user.id))),

  setMemberRole: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      memberUserId: uuid,
      role: z.enum(BUSINESS_ROLES),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await setBusinessMemberRole({
      ...input,
      actorId: ctx.user.id,
    }))),

  setMemberRoleByEmail: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      memberEmail: z.string().trim().email().max(254),
      role: z.enum(BUSINESS_ROLES),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await setBusinessMemberRoleByEmail({
      ...input,
      actorId: ctx.user.id,
    }))),

  listMembers: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessMembers(ctx.user.id, input.organizationId),
    )),

  createLocation: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      name: z.string().trim().min(2).max(120),
      roughLocation: z.string().trim().min(2).max(120),
      postalCode: z.string().trim().min(3).max(12).regex(/^[A-Za-z0-9 -]+$/),
      regionCode: z.string().trim().regex(/^US-[A-Z]{2}$/),
      timezone: z.string().trim().min(3).max(64),
      exactAddress: z.string().trim().min(5).max(500),
      accessProcedure: z.string().trim().min(3).max(2000),
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessLocation({
      ...input,
      actorId: ctx.user.id,
    }))),

  listLocations: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessLocations(ctx.user.id, input.organizationId),
    )),

  upsertBudgetPolicy: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      locationId: nullableUuid,
      serviceCategory: z.string().trim().min(1).max(80),
      perTaskCapCents: moneyCents,
      monthlyCapCents: moneyCents,
      autoApproveLimitCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      poRequired: z.boolean(),
      costCenterRequired: z.boolean(),
    }).strict().superRefine((input, context) => {
      if (input.monthlyCapCents < input.perTaskCapCents) {
        context.addIssue({ code: 'custom', path: ['monthlyCapCents'], message: 'Monthly cap must cover the per-task cap.' });
      }
      if (input.autoApproveLimitCents > input.perTaskCapCents) {
        context.addIssue({ code: 'custom', path: ['autoApproveLimitCents'], message: 'Auto-approval cannot exceed the per-task cap.' });
      }
    }))
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await upsertBusinessBudgetPolicy({
      ...input, actorId: ctx.user.id,
    }))),

  listBudgetPolicies: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessBudgetPolicies(ctx.user.id, input.organizationId),
    )),

  requestSpend: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      locationId: nullableUuid,
      serviceCategory: z.string().trim().min(1).max(80),
      amountCents: moneyCents,
      poNumber: z.string().trim().max(100).nullable(),
      costCenter: z.string().trim().max(100).nullable(),
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await requestBusinessSpend({
      ...input, actorId: ctx.user.id,
    }))),

  listApprovalQueue: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessApprovalQueue(ctx.user.id, input.organizationId),
    )),

  listMySpendRequests: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listMyBusinessSpendRequests(ctx.user.id, input.organizationId),
    )),

  decideApproval: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      approvalRequestId: uuid,
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().min(3).max(1000),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await decideBusinessApproval({
      ...input, actorId: ctx.user.id,
    }))),

  createServiceProfile: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      serviceCode: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/),
      serviceName: z.string().trim().min(2).max(120),
      serviceDescription: z.string().trim().min(10).max(4000),
      serviceExclusions: stringList(50, 300),
      bookingQuestions: stringList(30, 300),
      coveragePostalCodes: stringList(200, 12),
      maximumTravelMiles: z.number().int().min(0).max(500),
      weeklyCapacitySlots: z.number().int().min(0).max(10_000),
      blackoutDates: z.array(z.string().date()).max(366),
      pricingMode: z.enum(['INSTANT_CORRIDOR', 'STARTING_PRICE', 'QUOTE_REQUIRED']),
      corridorMinimumCents: moneyCents.nullable(),
      corridorMaximumCents: moneyCents.nullable(),
      responseMode: z.enum(['INDIVIDUAL_OFFERS', 'ROUTE_BUNDLES', 'RECURRING_CONTRACTS']),
      proofChecklist: stringList(30, 300),
      credentialRequirements: z.array(z.string().trim().regex(/^[A-Z0-9_-]{2,80}$/)).max(50),
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessServiceProfile({
      ...input, actorId: ctx.user.id,
    }))),

  listServiceProfiles: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessServiceProfiles(ctx.user.id, input.organizationId),
    )),

  submitCredential: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      membershipId: uuid,
      credentialType: z.string().trim().regex(/^[A-Z0-9_-]{2,80}$/),
      evidenceReference: z.string().trim().min(8).max(500),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await submitBusinessCredential({
      ...input, actorId: ctx.user.id,
    }))),

  assignServiceCrew: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      serviceProfileId: uuid,
      membershipId: uuid,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await assignBusinessServiceCrew({
      ...input, actorId: ctx.user.id,
    }))),

  activateServiceProfile: protectedProcedure
    .input(z.object({ organizationId: uuid, serviceProfileId: uuid }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await activateBusinessServiceProfile({
      ...input, actorId: ctx.user.id,
    }))),

  setProviderPreferenceByEmail: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      locationId: nullableUuid,
      serviceCategory: z.string().trim().min(1).max(80),
      providerEmail: z.string().trim().email().max(254),
      priority: z.enum(['PRIMARY', 'BACKUP']),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(
      await setBusinessProviderPreferenceByEmail({ ...input, actorId: ctx.user.id }),
    )),

  listProviderPreferences: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessProviderPreferences(ctx.user.id, input.organizationId),
    )),

  createWorkOrder: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      approvalRequestId: uuid,
      title: z.string().trim().min(3).max(255),
      description: z.string().trim().min(10).max(5000),
      requirements: z.string().trim().min(1).max(2000).nullable(),
      serviceWindowStart: z.string().datetime(),
      serviceWindowEnd: z.string().datetime(),
      expectedDurationMinutes: z.number().int().min(15).max(1440),
      requiredTools: stringList(20, 100),
      proofChecklist: stringList(20, 300).min(1),
      insideHome: z.boolean(),
      peoplePresent: z.boolean(),
      petsPresent: z.boolean(),
      caregiving: z.boolean(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessWorkOrder({
      ...input, actorId: ctx.user.id,
    }))),

  listWorkOrders: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessWorkOrders(ctx.user.id, input.organizationId),
    )),

  listProviderPerformance: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessProviderPerformance(ctx.user.id, input.organizationId),
    )),

  createInvoiceSnapshot: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      grouping: z.record(z.unknown()),
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessInvoiceSnapshot({
      ...input, actorId: ctx.user.id,
    }))),

  listInvoiceSnapshots: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessInvoiceSnapshots(ctx.user.id, input.organizationId),
    )),

  createRecurringTemplate: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      locationId: uuid,
      title: z.string().trim().min(3).max(255),
      description: z.string().trim().min(10).max(5000),
      category: z.string().trim().min(1).max(80),
      pattern: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
      dayOfWeek: z.number().int().min(1).max(7).nullable(),
      dayOfMonth: z.number().int().min(1).max(28).nullable(),
      timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      startDate: z.string().date(),
      endDate: z.string().date().nullable(),
      serviceWindowStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      serviceWindowEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      expectedDurationMinutes: z.number().int().min(15).max(1440),
      amountCents: moneyCents.max(2_000_000_000),
      templateBudgetCapCents: moneyCents.max(2_000_000_000),
      poNumber: z.string().trim().max(100).nullable(),
      costCenter: z.string().trim().max(100).nullable(),
      requiredTools: stringList(20, 100),
      proofChecklist: stringList(20, 300).min(1),
      blackoutDates: z.array(z.string().date()).max(366),
      cancellationNoticeHours: z.number().int().min(0).max(2160),
      nextReviewDate: z.string().date(),
      insideHome: z.boolean(),
      peoplePresent: z.boolean(),
      petsPresent: z.boolean(),
      caregiving: z.boolean(),
    }).strict().superRefine((input, context) => {
      if ((input.pattern === 'weekly' || input.pattern === 'biweekly') && input.dayOfWeek === null) {
        context.addIssue({ code: 'custom', path: ['dayOfWeek'], message: 'Weekly recurrence requires a day.' });
      }
      if (input.pattern === 'monthly' && input.dayOfMonth === null) {
        context.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'Monthly recurrence requires a day.' });
      }
      if (input.serviceWindowEnd <= input.serviceWindowStart) {
        context.addIssue({ code: 'custom', path: ['serviceWindowEnd'], message: 'Service window must end after it starts.' });
      }
      if (input.templateBudgetCapCents < input.amountCents) {
        context.addIssue({ code: 'custom', path: ['templateBudgetCapCents'], message: 'Budget must cover one occurrence.' });
      }
      if (input.endDate && input.endDate < input.startDate) {
        context.addIssue({ code: 'custom', path: ['endDate'], message: 'End date cannot precede start date.' });
      }
    }))
    .mutation(async ({ ctx, input }) => unwrapWorkspace(await createBusinessRecurringTemplate({
      ...input, actorId: ctx.user.id,
    }))),

  listRecurringTemplates: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrapWorkspace(
      await listBusinessRecurringTemplates(ctx.user.id, input.organizationId),
    )),
});

export type BusinessWorkspaceRouter = typeof businessWorkspaceRouter;
