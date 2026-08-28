import { TRPCError } from '@trpc/server';
import { computePlatformFeeCents } from '../lib/money.js';
import type { ControlledTemplateInput } from '../routers/recurringTaskSchemas.js';
import { ComplianceGuardianService } from './ComplianceGuardianService.js';
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
} from './RegionPolicyService.js';
import { createControlledRecurringTemplate } from './RecurringWorkService.js';
import { TaskRiskClassifier } from './TaskRiskClassifier.js';
import { isCareContent } from './TaskTemplateRegistry.js';

type RecurringRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

async function classifiedRisk(input: ControlledTemplateInput, userId: string) {
  const caregiving = input.caregiving || isCareContent(input.description);
  const templateSlug = caregiving
    ? 'care'
    : input.insideHome ? 'in_home' : 'standard_physical';
  const compliance = await ComplianceGuardianService.evaluate({
    description: input.description,
    userId,
    templateSlug,
  });
  if (compliance.tier === 'hard_block') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This recurring scope cannot be activated under HustleXP safety policy.',
    });
  }
  return TaskRiskClassifier.toLegacyRiskLevel(TaskRiskClassifier.classifyWithTemplate({
    insideHome: input.insideHome,
    peoplePresent: input.peoplePresent,
    petsPresent: input.petsPresent,
    caregiving,
  }, templateSlug, [], compliance));
}

async function recurringRegionPolicy(
  input: ControlledTemplateInput,
  riskLevel: RecurringRiskLevel,
  platformMarginCents: number,
) {
  const regionPolicy = await resolveRegionPolicy(input.regionCode);
  if (!regionPolicy) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Recurring work is not activated for this region.',
    });
  }
  const evaluation = evaluateTaskAgainstRegionPolicy(regionPolicy, {
    regionCode: input.regionCode,
    automationClassification: 'PRODUCTION',
    category: input.category,
    riskLevel,
    requiresProof: true,
    customerTotalCents: input.customerTotalCents,
    payoutCents: input.customerTotalCents - platformMarginCents,
    marginCents: platformMarginCents,
  });
  if (evaluation.allowed) return evaluation.snapshot;
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This recurring scope is not activated under the current regional policy.',
  });
}

function policyRequirements(required: boolean, policyId: string, policyVersion: string) {
  return required ? { required: true, policyId, policyVersion } : {};
}

export async function createControlledTemplate(
  input: ControlledTemplateInput,
  posterId: string,
) {
  const platformMarginCents = computePlatformFeeCents(input.customerTotalCents);
  const riskLevel = await classifiedRisk(input, posterId);
  const policy = await recurringRegionPolicy(input, riskLevel, platformMarginCents);
  const requiredTrustTier = riskLevel === 'LOW' ? 1 : riskLevel === 'MEDIUM' ? 2 : 3;
  const {
    insideHome: _insideHome,
    peoplePresent: _peoplePresent,
    petsPresent: _petsPresent,
    caregiving: _caregiving,
    ...controlledInput
  } = input;
  return createControlledRecurringTemplate({
    ...controlledInput,
    taskRecipe: {
      ...controlledInput.taskRecipe,
      regionPolicy: {
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        policyHash: policy.policyHash,
        proofRequired: policy.proofRequired,
        proofMinPhotos: policy.proofMinPhotos,
        proofMaxPhotos: policy.proofMaxPhotos,
        proofGpsRequired: policy.proofGpsRequired,
        backgroundCheckRequired: policy.backgroundCheckRequired,
      },
    },
    riskLevel,
    requiredTrustTier,
    licenseRequirements: policyRequirements(
      policy.licenseRequired,
      policy.policyId,
      policy.policyVersion,
    ),
    insuranceRequirements: policyRequirements(
      policy.insuranceRequired,
      policy.policyId,
      policy.policyVersion,
    ),
    credentialsValidUntil: null,
    providerPayoutCents: input.customerTotalCents - platformMarginCents,
    platformMarginCents,
    posterId,
    clientPrincipalType: 'HOUSEHOLD',
    clientPrincipalId: posterId,
    approverId: posterId,
  });
}
