export type TaskState =
  | 'OPEN' | 'MATCHING' | 'ACCEPTED' | 'PROOF_SUBMITTED'
  | 'DISPUTED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export type EscrowState =
  | 'PENDING' | 'FUNDED' | 'LOCKED_DISPUTE'
  | 'RELEASED' | 'REFUNDED' | 'REFUND_PARTIAL';

export type ProofState = 'PENDING' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type DisputeState = 'OPEN' | 'EVIDENCE_REQUESTED' | 'RESOLVED' | 'ESCALATED';
export type UserMode = 'worker' | 'poster';
export type CertaintyTier = 'STRONG' | 'MODERATE' | 'WEAK';
export type AIJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'KILLED';
export type LiveModeState = 'OFF' | 'ACTIVE' | 'COOLDOWN' | 'PAUSED';
export type TaskMode = 'STANDARD' | 'LIVE';
export type AccountStatus = 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'DELETED';
export type EvidenceAccessScope = 'uploader_only' | 'restricted' | 'dispute_reviewers' | 'admin_only';
export type EvidenceModerationStatus = 'pending' | 'approved' | 'flagged' | 'quarantined';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type TaskProgressState = 'POSTED' | 'ACCEPTED' | 'TRAVELING' | 'WORKING' | 'COMPLETED' | 'CLOSED';

export const TERMINAL_TASK_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];
export const TERMINAL_ESCROW_STATES: EscrowState[] = ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'];
export const VALID_PROGRESS_TRANSITIONS: Record<TaskProgressState, readonly TaskProgressState[]> = {
  POSTED: ['ACCEPTED'],
  ACCEPTED: ['TRAVELING'],
  TRAVELING: ['WORKING'],
  WORKING: ['COMPLETED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [],
} as const;
