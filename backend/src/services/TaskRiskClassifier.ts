/**
 * Task Risk Classifier — v1 (LOCKED)
 * 
 * Pre-Alpha Prerequisite: Authoritative task risk classification.
 * 
 * Rules:
 * - Rule-first, conservative
 * - Runs at task creation
 * - Writes tasks.risk_tier
 * - Immutable after creation
 */

// ============================================================================
// TASK RISK ENUM (Authoritative)
// ============================================================================

export enum TaskRisk {
  TIER_0 = 0, // outdoor, no property
  TIER_1 = 1, // assembly, yard work
  TIER_2 = 2, // entering home, no people
  TIER_3 = 3, // people / pets / care
}

// ============================================================================
// TYPES
// ============================================================================

export interface TaskRiskInput {
  insideHome: boolean;
  peoplePresent: boolean;
  petsPresent: boolean;
  caregiving: boolean;
}

// ============================================================================
// TASK RISK CLASSIFIER
// ============================================================================

export const TaskRiskClassifier = {
  /**
   * Classify task risk (pure function, deterministic)
   */
  classifyTaskRisk: (input: TaskRiskInput): TaskRisk => {
    // Rule 1: People/pets/caregiving → TIER_3 (highest risk)
    if (input.peoplePresent || input.petsPresent || input.caregiving) {
      return TaskRisk.TIER_3;
    }

    // Rule 2: Inside home → TIER_2
    if (input.insideHome) {
      return TaskRisk.TIER_2;
    }

    // Rule 3: Everything else → TIER_0/1 (use simple heuristics)
    // For alpha, default to TIER_0 (outdoor, no property)
    return TaskRisk.TIER_0;
  },

  /**
   * Map TaskRisk enum to legacy risk_level string
   * (for compatibility with existing schema)
   */
  toLegacyRiskLevel: (risk: TaskRisk): 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME' => {
    switch (risk) {
      case TaskRisk.TIER_0:
      case TaskRisk.TIER_1:
        return 'LOW';
      case TaskRisk.TIER_2:
        return 'HIGH';
      case TaskRisk.TIER_3:
        return 'IN_HOME';
      default:
        return 'LOW';
    }
  },
};
