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
  category?: string;
  deadline?: Date;
  dispatchExpiresAt?: Date;
  requiresProof?: boolean;
  riskLevel?: TaskRiskLevel;
  mode?: 'STANDARD' | 'LIVE';
  liveBroadcastRadiusMiles?: number;
  instantMode?: boolean;
  sensitive?: boolean;
  templateSlug?: string;
  clientIdempotencyKey?: string;
  roughArea?: string;
  automationClassification?: 'PRODUCTION' | 'CONTROLLED_TEST';
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
    category: optionalValue(params.category),
    deadline: optionalDate(params.deadline),
    dispatchExpiresAt: optionalDate(params.dispatchExpiresAt),
    requiresProof: defaultValue(params.requiresProof, true),
    riskLevel: defaultValue(params.riskLevel, 'LOW'),
    mode: defaultValue(params.mode, 'STANDARD'),
    liveBroadcastRadiusMiles: optionalValue(params.liveBroadcastRadiusMiles),
    instantMode: defaultValue(params.instantMode, false),
    sensitive: defaultValue(params.sensitive, false),
    templateSlug: optionalValue(params.templateSlug),
    automationClassification: defaultValue(params.automationClassification, 'PRODUCTION'),
    ...(params.hustlerPayoutCents !== undefined || params.platformMarginCents !== undefined
      ? {
          hustlerPayoutCents: optionalValue(params.hustlerPayoutCents),
          platformMarginCents: optionalValue(params.platformMarginCents),
        }
      : {}),
  })).digest('hex');
}
