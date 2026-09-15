import {
  isCareContent,
  isInHomeContent,
  isLicensedWorkContent,
} from './TaskTemplatePolicy.js';

export type ManualTaskRiskLevel =
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'IN_HOME';

export function deriveManualTaskRisk(
  description: string,
): ManualTaskRiskLevel {
  if (isCareContent(description)) {
    return 'IN_HOME';
  }

  if (
    isInHomeContent(description) ||
    isLicensedWorkContent(description)
  ) {
    return 'HIGH';
  }

  return 'LOW';
}
