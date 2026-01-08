/**
 * HustleXP Type Definitions v1.0.0
 * 
 * CONSTITUTIONAL: These types MUST match schema.sql exactly.
 * Any drift between types and schema is a build failure.
 * 
 * @see schema.sql v1.0.0
 * @see PRODUCT_SPEC.md
 */

// ============================================================================
// ENUMS (Match CHECK constraints in schema.sql)
// ============================================================================

export type TaskState = 
  | 'OPEN'
  | 'ACCEPTED'
  | 'PROOF_SUBMITTED'
  | 'DISPUTED'
  | 'COMPLETED'      // TERMINAL
  | 'CANCELLED'      // TERMINAL
  | 'EXPIRED';       // TERMINAL

export type EscrowState =
  | 'PENDING'
  | 'FUNDED'
  | 'LOCKED_DISPUTE'
  | 'RELEASED'        // TERMINAL
  | 'REFUNDED'        // TERMINAL
  | 'REFUND_PARTIAL'; // TERMINAL

export type ProofState =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'NEEDS_MORE';

export type DisputeState =
  | 'OPEN'
  | 'EVIDENCE_REQUESTED'
  | 'UNDER_REVIEW'
  | 'RESOLVED_WORKER'
  | 'RESOLVED_POSTER'
  | 'RESOLVED_SPLIT';

export type UserMode = 'worker' | 'poster';

export type CertaintyTier = 'STRONG' | 'MODERATE' | 'WEAK';

export type AIJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';

// ============================================================================
// TERMINAL STATE CONSTANTS
// ============================================================================

export const TERMINAL_TASK_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];
export const TERMINAL_ESCROW_STATES: EscrowState[] = ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'];

// ============================================================================
// CORE DOMAIN TYPES
// ============================================================================

export interface User {
  id: string;
  email: string;
  phone?: string;
  full_name: string;
  avatar_url?: string;
  firebase_uid?: string;
  
  // Role
  default_mode: UserMode;
  
  // Onboarding
  onboarding_version?: string;
  onboarding_completed_at?: Date;
  role_confidence_worker?: number;
  role_confidence_poster?: number;
  role_certainty_tier?: CertaintyTier;
  role_was_overridden: boolean;
  inconsistency_flags?: string[];
  
  // Profile signals
  risk_tolerance?: number;
  urgency_bias?: number;
  authority_expectation?: number;
  price_sensitivity?: number;
  
  // Trust & XP
  trust_tier: number;
  xp_total: number;
  current_level: number;
  current_streak: number;
  last_task_completed_at?: Date;
  streak_grace_expires_at?: Date;
  
  // Verification
  is_verified: boolean;
  verified_at?: Date;
  student_id_verified: boolean;
  
  // Stripe
  stripe_customer_id?: string;
  stripe_connect_id?: string;
  
  // Timestamps
  created_at: Date;
  updated_at: Date;
}

export interface Task {
  id: string;
  poster_id: string;
  worker_id?: string;
  
  title: string;
  description: string;
  requirements?: string;
  location?: string;
  category?: string;
  
  // Price in USD cents (INTEGER - no floats!)
  price: number;
  scope_hash?: string;
  
  state: TaskState;
  
  // Timestamps
  deadline?: Date;
  accepted_at?: Date;
  proof_submitted_at?: Date;
  completed_at?: Date;
  cancelled_at?: Date;
  expired_at?: Date;
  
  requires_proof: boolean;
  
  created_at: Date;
  updated_at: Date;
}

export interface Escrow {
  id: string;
  task_id: string;
  
  // Amount in USD cents (INTEGER - no floats!)
  amount: number;
  
  state: EscrowState;
  
  // Stripe
  stripe_payment_intent_id?: string;
  stripe_transfer_id?: string;
  
  // Timestamps
  funded_at?: Date;
  released_at?: Date;
  refunded_at?: Date;
  
  created_at: Date;
  updated_at: Date;
}

export interface Proof {
  id: string;
  task_id: string;
  submitter_id: string;
  
  state: ProofState;
  
  notes?: string;
  rejection_reason?: string;
  
  // AI analysis
  ai_job_id?: string;
  ai_confidence?: number;
  
  submitted_at: Date;
  reviewed_at?: Date;
  
  created_at: Date;
  updated_at: Date;
}

export interface ProofPhoto {
  id: string;
  proof_id: string;
  storage_key: string;
  content_type: string;
  file_size_bytes: number;
  checksum_sha256: string;
  capture_time?: Date;
  sequence_number: number;
  created_at: Date;
}

export interface XPLedgerEntry {
  id: string;
  user_id: string;
  task_id: string;
  escrow_id: string;
  
  base_xp: number;
  streak_multiplier: number;
  decay_factor: number;
  effective_xp: number;
  
  reason: string;
  
  // Audit fields
  user_xp_before: number;
  user_xp_after: number;
  user_level_before: number;
  user_level_after: number;
  user_streak_at_award: number;
  
  awarded_at: Date;
}

export interface TrustLedgerEntry {
  id: string;
  user_id: string;
  
  old_tier: number;
  new_tier: number;
  
  reason: string;
  evidence?: Record<string, unknown>;
  
  changed_at: Date;
}

export interface Badge {
  id: string;
  user_id: string;
  badge_type: string;
  tier: number;
  
  unlocked_at: Date;
  animation_shown_at?: Date;
}

export interface Dispute {
  id: string;
  task_id: string;
  escrow_id: string;
  
  initiator_id: string;
  initiator_role: 'worker' | 'poster';
  
  reason: string;
  state: DisputeState;
  
  admin_id?: string;
  resolution_notes?: string;
  
  // Split resolution
  worker_percent?: number;
  poster_percent?: number;
  
  created_at: Date;
  updated_at: Date;
  resolved_at?: Date;
}

// ============================================================================
// AI INFRASTRUCTURE TYPES (AI_INFRASTRUCTURE.md)
// ============================================================================

export interface AIEvent {
  id: string;
  subsystem: string;
  event_type: string;
  
  actor_user_id?: string;
  subject_user_id?: string;
  task_id?: string;
  dispute_id?: string;
  
  payload: Record<string, unknown>;
  payload_hash: string;
  schema_version: string;
  
  created_at: Date;
}

export interface AIJob {
  id: string;
  event_id: string;
  subsystem: string;
  
  status: AIJobStatus;
  
  model_id?: string;
  prompt_hash?: string;
  
  started_at?: Date;
  completed_at?: Date;
  duration_ms?: number;
  
  error_code?: string;
  error_message?: string;
  retry_count: number;
  
  created_at: Date;
  updated_at: Date;
}

export interface AIProposal {
  id: string;
  job_id: string;
  
  proposal_type: string;
  proposal_data: Record<string, unknown>;
  confidence: number;
  
  raw_response?: Record<string, unknown>;
  token_count?: number;
  
  created_at: Date;
}

export interface AIDecision {
  id: string;
  proposal_id: string;
  
  decision: 'ACCEPTED' | 'REJECTED' | 'MODIFIED' | 'DEFERRED';
  decision_reason?: string;
  
  validator_version: string;
  applied_at?: Date;
  
  created_at: Date;
}

// ============================================================================
// SERVICE RESULT TYPES
// ============================================================================

export type ServiceResult<T> = 
  | { success: true; data: T }
  | { success: false; error: ServiceError };

export interface ServiceError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Error codes (match trigger ERRCODE values)
export const ErrorCodes = {
  // Invariant violations
  INV_1_VIOLATION: 'HX101',  // XP requires RELEASED escrow
  INV_2_VIOLATION: 'HX201',  // RELEASED requires COMPLETED task
  INV_3_VIOLATION: 'HX301',  // COMPLETED requires ACCEPTED proof
  INV_4_VIOLATION: 'HX401',  // Escrow amount immutable
  INV_5_VIOLATION: '23505',  // Unique constraint (XP idempotency)
  
  // Terminal state violations
  TASK_TERMINAL: 'HX002',
  ESCROW_TERMINAL: 'HX002',
  
  // General errors
  NOT_FOUND: 'HX404',
  INVALID_STATE: 'HX400',
  INVALID_TRANSITION: 'HX400',
  UNAUTHORIZED: 'HX401',
  FORBIDDEN: 'HX403',
} as const;
