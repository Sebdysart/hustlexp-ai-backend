import type {
  RegionPolicyTaskInput,
} from './RegionPolicyService.js';

export interface ManualTaskPolicyInput {
  regionCode: string;
  category: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  customerTotalCents?: number;
  payoutCents?: number;
  platformMarginCents?: number;
}

export function buildManualTaskPolicyInput(
  input: ManualTaskPolicyInput,
): RegionPolicyTaskInput {
  return {
    regionCode: input.regionCode,
    automationClassification: 'PRODUCTION',
    category: input.category,
    riskLevel: input.riskLevel,
    requiresProof: true,
    customerTotalCents: input.customerTotalCents,
    payoutCents: input.payoutCents,
    marginCents: input.platformMarginCents,
  };
}
