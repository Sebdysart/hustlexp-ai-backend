import { z } from 'zod';

import { operationsAdminProcedure, protectedProcedure, router, Schemas } from '../trpc.js';
import {
  universalV1TaskOpportunityProviderClasses,
  universalV1TaskOpportunityService,
} from '../services/UniversalV1TaskOpportunityService.js';

const exactVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);
const workCategoryCode = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,99}$/u);

const providerSelection = {
  providerOrganizationId: Schemas.uuid.optional(),
  businessCredentialId: Schemas.uuid.optional(),
} as const;

function requireOrganizationForCredential(
  input: { providerOrganizationId?: string; businessCredentialId?: string },
  context: z.RefinementCtx
) {
  if (input.businessCredentialId && !input.providerOrganizationId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['businessCredentialId'],
      message: 'A trade credential must be bound to its provider organization.',
    });
  }
}

/**
 * Privacy-redacted provider discovery and observation-only EXPRESS_INTEREST.
 * Authentication binds the named app actor; PostgreSQL rechecks the exact
 * current provider observations. No procedure grants eligibility, assignment,
 * address/contact, reservation, financial, payable, or earning authority.
 */
export const universalV1TaskOpportunitiesRouter = router({
  browse: protectedProcedure
    .input(
      z
        .object({
          serviceCellAuthorityId: Schemas.uuid,
          workCategoryCode: workCategoryCode.optional(),
          ...providerSelection,
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).max(10_000).default(0),
        })
        .strict()
        .superRefine(requireOrganizationForCredential)
    )
    .query(({ ctx, input }) => universalV1TaskOpportunityService.browse(ctx, input)),

  expressInterest: protectedProcedure
    .input(
      z
        .object({
          opportunityId: Schemas.uuid,
          expectedOpportunityVersion: exactVersion,
          ...providerSelection,
          idempotencyKey,
        })
        .strict()
        .superRefine(requireOrganizationForCredential)
    )
    .mutation(({ ctx, input }) => universalV1TaskOpportunityService.expressInterest(ctx, input)),

  getMyPreEstimateJourneyState: protectedProcedure
    .input(
      z
        .object({
          interestId: Schemas.uuid,
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      universalV1TaskOpportunityService.getMyPreEstimateJourneyState(ctx, input)),

  listMine: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).max(10_000).default(0),
        })
        .strict()
    )
    .query(({ ctx, input }) => universalV1TaskOpportunityService.listMine(ctx, input)),

  listForOps: operationsAdminProcedure
    .input(
      z
        .object({
          providerClass: z.enum(universalV1TaskOpportunityProviderClasses).optional(),
          workCategoryCode: workCategoryCode.optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).max(10_000).default(0),
        })
        .strict()
    )
    .query(({ ctx, input }) => universalV1TaskOpportunityService.listForOps(ctx, input)),
});

export type UniversalV1TaskOpportunitiesRouter = typeof universalV1TaskOpportunitiesRouter;
