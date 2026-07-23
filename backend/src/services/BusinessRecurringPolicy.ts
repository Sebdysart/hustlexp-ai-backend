import type { ServiceResult } from '../types.js';
import { ComplianceGuardianService } from './ComplianceGuardianService.js';
import type {
  BusinessRecurringSource,
  CreateBusinessRecurringTemplateInput,
} from './BusinessRecurringTypes.js';
import { TaskRiskClassifier } from './TaskRiskClassifier.js';
import { isCareContent } from './TaskTemplateRegistry.js';

export type BusinessRecurringRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

type PolicyFailure = { code: string; message: string };

const SOURCE_POLICY_RULES: ReadonlyArray<{
  failed: (
    source: BusinessRecurringSource,
    input: CreateBusinessRecurringTemplateInput,
  ) => boolean;
  failure: PolicyFailure;
}> = [
  {
    failed: (source) => source.per_task_cap_cents === null,
    failure: {
      code: 'BUSINESS_RECURRING_POLICY_REQUIRED',
      message: 'An active budget policy is required before recurring work can be created.',
    },
  },
  {
    failed: (source, input) => input.amountCents > Number(source.per_task_cap_cents),
    failure: {
      code: 'BUSINESS_RECURRING_TASK_CAP_EXCEEDED',
      message: 'The recurring amount exceeds the current per-task cap.',
    },
  },
  {
    failed: (_source, input) => input.templateBudgetCapCents < input.amountCents,
    failure: {
      code: 'BUSINESS_RECURRING_BUDGET_INVALID',
      message: 'The template budget must cover at least one occurrence.',
    },
  },
  {
    failed: (source, input) => Boolean(source.po_required && !input.poNumber?.trim()),
    failure: {
      code: 'BUSINESS_RECURRING_PO_REQUIRED',
      message: 'The selected policy requires a purchase order.',
    },
  },
  {
    failed: (source, input) => Boolean(source.cost_center_required && !input.costCenter?.trim()),
    failure: {
      code: 'BUSINESS_RECURRING_COST_CENTER_REQUIRED',
      message: 'The selected policy requires a cost center.',
    },
  },
];

function templateSlug(caregiving: boolean, insideHome: boolean): string {
  if (caregiving) return 'care';
  return insideHome ? 'in_home' : 'standard_physical';
}

export async function evaluateBusinessRecurringSafety(
  input: CreateBusinessRecurringTemplateInput,
): Promise<ServiceResult<{ riskLevel: BusinessRecurringRiskLevel }>> {
  const caregiving = input.caregiving || isCareContent(input.description);
  const slug = templateSlug(caregiving, input.insideHome);
  const compliance = await ComplianceGuardianService.evaluate({
    description: input.description,
    userId: input.actorId,
    templateSlug: slug,
  });
  if (compliance.tier === 'hard_block') return {
    success: false,
    error: {
      code: 'BUSINESS_RECURRING_COMPLIANCE_BLOCKED',
      message: 'This recurring template cannot be created under HustleXP safety policy.',
    },
  };
  const risk = TaskRiskClassifier.classifyWithTemplate({
    insideHome: input.insideHome,
    peoplePresent: input.peoplePresent,
    petsPresent: input.petsPresent,
    caregiving,
  }, slug, [], compliance);
  return {
    success: true,
    data: { riskLevel: TaskRiskClassifier.toLegacyRiskLevel(risk) },
  };
}

export function businessRecurringPolicyFailure(
  source: BusinessRecurringSource,
  input: CreateBusinessRecurringTemplateInput,
): PolicyFailure | null {
  return SOURCE_POLICY_RULES.find((rule) => rule.failed(source, input))?.failure ?? null;
}
