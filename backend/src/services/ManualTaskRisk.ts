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

export interface ManualTaskRiskContext {
  category?: string | null;
}

const HAZARDOUS_CLEANING_CONTENT = /\b(?:biohazards?|biohazardous|blood(?:stains?)?|bodily\s+fluids?|human\s+(?:waste|feces|faeces)|sewage|crime[-\s]?scene|sharps?|needles?|asbestos|mold|mould|hoard(?:ing|er)?|hazardous\s+(?:materials?|chemicals?|waste)|chemical\s+(?:spill|contamination|residue|cleanup|clean[-\s]?up))\b/i;

export function isHazardousCleaningContent(description: string): boolean {
  return HAZARDOUS_CLEANING_CONTENT.test(description);
}

export function deriveManualTaskRisk(
  description: string,
  context: ManualTaskRiskContext = {},
): ManualTaskRiskLevel {
  if (context.category === 'cleaning') {
    if (isHazardousCleaningContent(description)) {
      return 'HIGH';
    }

    // Entering a customer's home raises ordinary cleaning above the outdoor
    // baseline, but it is not hazardous work. US-WA deliberately permits this
    // MEDIUM lane while continuing to reject HIGH-risk cleanup.
    return isInHomeContent(description) ? 'MEDIUM' : 'LOW';
  }

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
