import type {
  RegionPolicyTaskInput,
} from './RegionPolicyService.js';

export interface ManualTaskPolicyInput {
  regionCode: string;
  category: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
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
  };
}
