export const UNIVERSAL_V1_ROUTING_OUTCOMES = [
  'FULFILLMENT_CANDIDATE',
  'ESTIMATE_REQUIRED',
  'MANUAL_SOURCING',
  'REFERRAL',
  'WAITLIST',
  'DECLINE',
] as const;

export type UniversalV1RoutingOutcome = (typeof UNIVERSAL_V1_ROUTING_OUTCOMES)[number];

export const UNIVERSAL_V1_ROUTING_POLICY_VERSION = 'universal-v1-intake-1.2.0';

export type TaskDraftCategory =
  | 'moving'
  | 'furniture_assembly'
  | 'errands'
  | 'yard'
  | 'tech'
  | 'cleaning'
  | 'handyman'
  | 'other';

export const UNIVERSAL_V1_WORK_CATEGORY_CODES = [
  'moving',
  'furniture_assembly',
  'errands',
  'yard',
  'tech',
  'cleaning',
  'handyman',
  'other',
  'plumbing',
  'electrical',
  'hvac',
  'roofing',
  'general_contracting',
] as const;

export type UniversalV1WorkCategoryCode =
  (typeof UNIVERSAL_V1_WORK_CATEGORY_CODES)[number];

export type UniversalV1RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

export type UniversalV1ServiceCellAvailability =
  | 'ACTIVE'
  | 'WAITLIST'
  | 'UNAVAILABLE'
  | 'UNRESOLVED';

export type UniversalV1ServiceCellEnvironment =
  | 'local'
  | 'preview'
  | 'staging'
  | 'production';

export interface UniversalV1ServiceCellAuthoritySnapshot {
  id: string;
  postalCode: string;
  regionCode: string;
  roughLocation: string;
  availability: Exclude<UniversalV1ServiceCellAvailability, 'UNRESOLVED'>;
  environment: UniversalV1ServiceCellEnvironment;
  authorityKind: 'SYNTHETIC_FIXTURE' | 'SIGNED_DATASET';
  authorityVersion: number;
  evidenceSha256: string;
}

export interface UniversalV1TaskDraftRouteContext {
  workCategoryCode: UniversalV1WorkCategoryCode;
  regionCode: string | null;
  roughLocation: string | null;
  riskLevel: UniversalV1RiskLevel;
  requiresProof: true;
  finalAvailabilityConfirmationRequired: true;
  postalCode: string | null;
  serviceCellAuthorityId: string | null;
  serviceCellAuthorityVersion: number | null;
  serviceCellAuthorityEnvironment: UniversalV1ServiceCellEnvironment | null;
  serviceCellAuthorityKind: 'SYNTHETIC_FIXTURE' | 'SIGNED_DATASET' | null;
  serviceCellEvidenceSha256: string | null;
  serviceCellAvailability: UniversalV1ServiceCellAvailability;
  blockerCodes: string[];
}

export interface UniversalV1ServiceCellResolution {
  postalCode: string | null;
  authority: UniversalV1ServiceCellAuthoritySnapshot | null;
  blockerCodes: string[];
}

export interface TaskDraftRoutingInput {
  category: TaskDraftCategory;
  rawInput: string;
  answers: Record<string, unknown>;
  safetyEvidence: string;
  serverRiskFlags: readonly string[];
  scopeEvidenceComplete: boolean;
  nowMs: number;
  routeContext: UniversalV1TaskDraftRouteContext;
}

export interface TaskDraftRoutingDecision {
  outcome: UniversalV1RoutingOutcome;
  reasonCodes: string[];
  policyVersion: string;
  routeContext: UniversalV1TaskDraftRouteContext | null;
}
