import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hustlerProcedure, trustAdminProcedure } from '../trpc.js';
import * as BackgroundCheckService from '../services/BackgroundCheckService.js';
import * as WorkerScreeningRightsService from '../services/WorkerScreeningRightsService.js';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_COPY,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
  WORKER_SCREENING_DISCLOSURE_COPY,
  WORKER_SCREENING_DISCLOSURE_HASH,
  WORKER_SCREENING_POLICY_VERSION,
} from '../services/WorkerScreeningRightsPolicy.js';
import {
  LocalCertificationScreeningProvider,
  localCertificationScreeningEnabled,
} from '../services/LocalCertificationScreeningProvider.js';

const idempotencyKey = z.string().min(8).max(200);

function throwLocalTestScreeningError(error: { code: string; message: string }): never {
  const code = error.code.includes('CONFLICT')
    ? 'CONFLICT'
    : error.code.includes('NOT_FOUND')
      ? 'NOT_FOUND'
      : 'PRECONDITION_FAILED';
  throw new TRPCError({ code, message: error.message });
}

export const capabilityScreeningProcedures = {
  initiateBackgroundCheck: hustlerProcedure
    .input(z.object({
      provider: z.enum(['checkr', 'sterling', 'goodhire', 'manual']),
      consentId: z.string().uuid(),
    }))
    .mutation(({ ctx, input }) => BackgroundCheckService.initiateBackgroundCheck({
      userId: ctx.user.id,
      provider: input.provider,
      consentId: input.consentId,
    })),

  getBackgroundCheck: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => BackgroundCheckService.getUserBackgroundCheck(ctx.user.id)),

  getLocalTestScreeningDisclosure: hustlerProcedure
    .input(z.void())
    .query(() => ({
      enabled: localCertificationScreeningEnabled(),
      provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
      disclosureVersion: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
      disclosureCopy: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_COPY,
      policyVersion: WORKER_SCREENING_POLICY_VERSION,
      standaloneDisclosure: true,
      purpose: LOCAL_CERTIFICATION_SCREENING_PURPOSE,
      isTest: true,
      externalReportOrdered: false,
      productionEligibilityUnchanged: true,
    })),

  initiateLocalTestBackgroundCheck: hustlerProcedure
    .input(z.object({
      consentId: z.string().uuid(),
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await LocalCertificationScreeningProvider.initiate({
        workerId: ctx.user.id,
        consentId: input.consentId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) throwLocalTestScreeningError(result.error);
      return result.data;
    }),

  getScreeningDisclosure: hustlerProcedure
    .input(z.void())
    .query(() => ({
      disclosureVersion: WorkerScreeningRightsService.WORKER_SCREENING_DISCLOSURE_VERSION,
      disclosureHash: WORKER_SCREENING_DISCLOSURE_HASH,
      disclosureCopy: WORKER_SCREENING_DISCLOSURE_COPY,
      policyVersion: WORKER_SCREENING_POLICY_VERSION,
      standaloneDisclosure: true,
      purpose: 'Determine eligibility only for task categories that explicitly require enhanced screening.',
      workerRights: [
        'Inspect the report used for a decision.',
        'Dispute inaccurate or incomplete report information before final action.',
        'Receive pre-adverse and final notices when report information affects eligibility.',
        'Appeal a final HustleXP decision to a new human reviewer.',
        'Keep unchanged rank and access to categories that do not require enhanced screening.',
        'Withdraw permission for future screening orders.',
      ],
      providerDecisionDisclaimer: 'The screening provider supplies report information but does not make HustleXP eligibility decisions.',
    })),

  grantScreeningConsent: hustlerProcedure
    .input(z.object({
      provider: z.enum(['checkr', 'sterling', 'goodhire', 'manual', 'local_certification_test']),
      disclosureVersion: z.string().min(1).max(100),
      disclosureHash: z.string().regex(/^[a-f0-9]{64}$/),
      purpose: z.string().min(10).max(500),
      disclosurePresentedStandalone: z.literal(true),
      consentGranted: z.literal(true),
      purposeAcknowledged: z.literal(true),
      rightsSummaryAcknowledged: z.literal(true),
      providerNamed: z.literal(true),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.grantScreeningConsent({
      workerId: ctx.user.id,
      ...input,
    })),

  revokeFutureScreeningConsent: hustlerProcedure
    .input(z.object({ consentId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.revokeFutureScreeningConsent({
      workerId: ctx.user.id,
      ...input,
    })),

  getMyScreeningRights: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => WorkerScreeningRightsService.getMyScreeningRights(ctx.user.id)),

  disputeScreeningReport: hustlerProcedure
    .input(z.object({
      checkId: z.string().uuid(),
      reason: z.string().trim().min(10).max(4000),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.submitScreeningDispute({
      workerId: ctx.user.id,
      ...input,
    })),

  appealScreeningDecision: hustlerProcedure
    .input(z.object({
      checkId: z.string().uuid(),
      reason: z.string().trim().min(10).max(4000),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.submitScreeningAppeal({
      workerId: ctx.user.id,
      ...input,
    })),

  beginScreeningPreAdverseAction: trustAdminProcedure
    .input(z.object({
      checkId: z.string().uuid(),
      reasonCodes: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
      providerName: z.string().trim().min(1).max(200),
      providerAddress: z.string().trim().min(1).max(500),
      providerPhone: z.string().trim().min(1).max(50),
      reportAccessPath: z.string().trim().min(1).max(1000),
      disputeInstructions: z.string().trim().min(10).max(2000),
      rightsSummaryVersion: z.string().trim().min(1).max(100),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.beginPreAdverseAction({
      adminId: ctx.user.id,
      ...input,
    })),

  resolveScreeningDispute: trustAdminProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
      decision: z.enum(['CORRECTED_CLEAR', 'UPHELD']),
      resolutionNote: z.string().trim().min(10).max(4000),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.resolveScreeningDispute({
      adminId: ctx.user.id,
      ...input,
    })),

  finalizeScreeningAdverseAction: trustAdminProcedure
    .input(z.object({ checkId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.finalizeAdverseAction({
      adminId: ctx.user.id,
      ...input,
    })),

  resolveScreeningAppeal: trustAdminProcedure
    .input(z.object({
      appealId: z.string().uuid(),
      decision: z.enum(['OVERTURNED', 'UPHELD']),
      resolutionNote: z.string().trim().min(10).max(4000),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerScreeningRightsService.resolveScreeningAppeal({
      adminId: ctx.user.id,
      ...input,
    })),
};
