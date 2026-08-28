import { createHash } from 'node:crypto';
import { TERMINAL_TASK_STATES } from '../types.js';
import type { TaskProgressState, TaskState } from '../types.js';

export type TaskRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

export interface CreateTaskParams {
  posterId: string;
  title: string;
  description: string;
  price: number;
  hustlerPayoutCents?: number;
  platformMarginCents?: number;
  requirements?: string;
  location?: string;
  regionCode?: string;
  category?: string;
  deadline?: Date;
  dispatchExpiresAt?: Date;
  requiresProof?: boolean;
  riskLevel?: TaskRiskLevel;
  /** Original caller-supplied risk used only for idempotency intent hashing. */
  requestedRiskLevel?: TaskRiskLevel;
  mode?: 'STANDARD' | 'LIVE';
  liveBroadcastRadiusMiles?: number;
  instantMode?: boolean;
  sensitive?: boolean;
  templateSlug?: string;
  clientIdempotencyKey?: string;
  roughArea?: string;
  automationClassification?: 'PRODUCTION' | 'CONTROLLED_TEST';
  proofSteps?: string[];
  estimatedDurationMinutes?: number;
  requiredTools?: string[];
  aiScopeObservationId?: string;
  insideHome?: boolean;
  peoplePresent?: boolean;
  petsPresent?: boolean;
  wildcardFlags?: string[];
  complianceAiSignalsComputed?: boolean;
  complianceDeceptionDetected?: boolean;
  complianceGenuinelyBizarre?: boolean;
  illegalRiskScore?: number;
  complianceGuardianNotes?: unknown;
  trustTierRequired?: number;
  completionCriteria?: { type: 'photo_proof' | 'check_in_check_out' | 'session_completion' | 'hybrid' };
  contentRelease?: boolean;
  mutualConsentRequired?: boolean;
  cancellationWindowHours?: number;
  lateCancelPct?: number;
  cancellationPolicyVersion?: string;
  licensedContentRequired?: boolean;
  repeatSourceTaskId?: string;
  preferredWorkerId?: string;
  retentionConversion?: 'REBOOK';
  counterSourceTaskId?: string;
  counterOfferId?: string;
  counterCandidateId?: string;
}

export interface AcceptTaskParams {
  taskId: string;
  workerId: string;
}

export interface AdvanceProgressParams {
  taskId: string;
  to: TaskProgressState;
  actor: { type: 'worker' | 'system'; userId?: string };
}

export const VALID_TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  OPEN: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  MATCHING: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['PROOF_SUBMITTED', 'CANCELLED', 'EXPIRED'],
  PROOF_SUBMITTED: ['COMPLETED', 'DISPUTED', 'ACCEPTED'],
  DISPUTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

function optionalValue<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function defaultValue<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function optionalDate(value: Date | undefined): string | null {
  return value === undefined ? null : value.toISOString();
}

export function buildTaskCreateRequestHash(params: CreateTaskParams): string {
  return createHash('sha256').update(JSON.stringify({
    posterId: params.posterId,
    title: params.title,
    description: params.description,
    price: params.price,
    requirements: optionalValue(params.requirements),
    location: optionalValue(params.location),
    roughArea: optionalValue(params.roughArea),
    ...(params.regionCode !== undefined ? { regionCode: params.regionCode } : {}),
    category: optionalValue(params.category),
    deadline: optionalDate(params.deadline),
    dispatchExpiresAt: optionalDate(params.dispatchExpiresAt),
    requiresProof: defaultValue(params.requiresProof, true),
    riskLevel: defaultValue(params.requestedRiskLevel ?? params.riskLevel, 'LOW'),
    mode: defaultValue(params.mode, 'STANDARD'),
    liveBroadcastRadiusMiles: optionalValue(params.liveBroadcastRadiusMiles),
    instantMode: defaultValue(params.instantMode, false),
    sensitive: defaultValue(params.sensitive, false),
    templateSlug: optionalValue(params.templateSlug),
    automationClassification: defaultValue(params.automationClassification, 'PRODUCTION'),
    ...(params.insideHome !== undefined ? { insideHome: params.insideHome } : {}),
    ...(params.peoplePresent !== undefined ? { peoplePresent: params.peoplePresent } : {}),
    ...(params.petsPresent !== undefined ? { petsPresent: params.petsPresent } : {}),
    ...(params.wildcardFlags !== undefined ? { wildcardFlags: params.wildcardFlags } : {}),
    ...(params.proofSteps !== undefined ? { proofSteps: params.proofSteps } : {}),
    ...(params.estimatedDurationMinutes !== undefined ? { estimatedDurationMinutes: params.estimatedDurationMinutes } : {}),
    ...(params.requiredTools !== undefined ? { requiredTools: params.requiredTools } : {}),
    ...(params.aiScopeObservationId !== undefined ? { aiScopeObservationId: params.aiScopeObservationId } : {}),
    ...(params.repeatSourceTaskId !== undefined ? { repeatSourceTaskId: params.repeatSourceTaskId } : {}),
    ...(params.preferredWorkerId !== undefined ? { preferredWorkerId: params.preferredWorkerId } : {}),
    ...(params.retentionConversion !== undefined ? { retentionConversion: params.retentionConversion } : {}),
    ...(params.counterSourceTaskId !== undefined ? { counterSourceTaskId: params.counterSourceTaskId } : {}),
    ...(params.counterOfferId !== undefined ? { counterOfferId: params.counterOfferId } : {}),
    ...(params.counterCandidateId !== undefined ? { counterCandidateId: params.counterCandidateId } : {}),
    ...(params.hustlerPayoutCents !== undefined || params.platformMarginCents !== undefined
      ? {
          hustlerPayoutCents: optionalValue(params.hustlerPayoutCents),
          platformMarginCents: optionalValue(params.platformMarginCents),
        }
      : {}),
  })).digest('hex');
}

export interface TaskScopeHashInput {
  title: string;
  description: string;
  requirements?: string | null;
  checklist: string[];
  customerTotalCents: number;
  hustlerPayoutCents?: number | null;
}

export function buildTaskScopeHash(input: TaskScopeHashInput): string {
  return createHash('sha256').update(JSON.stringify({
    title: input.title.trim(),
    description: input.description.trim(),
    requirements: input.requirements?.trim() || null,
    checklist: input.checklist.map((step) => step.trim()),
    customerTotalCents: input.customerTotalCents,
    hustlerPayoutCents: input.hustlerPayoutCents ?? null,
  })).digest('hex');
}

export function buildScopeChecklist(params: Pick<CreateTaskParams, 'title' | 'requirements' | 'requiresProof' | 'proofSteps'>): string[] {
  const explicit = (params.proofSteps ?? []).map((step) => step.trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;

  const requirements = (params.requirements ?? '')
    .split(/\r?\n|[;•]/)
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 8);
  const checklist = [
    'Confirm the approved scope before work begins.',
    ...requirements,
    `Complete the approved work: ${params.title.trim()}.`,
  ];
  if (params.requiresProof ?? true) checklist.push('Capture completion evidence for this approved scope.');
  return checklist;
}
