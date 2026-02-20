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
  | 'MATCHING'       // Instant mode: searching for hustler
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
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED';

export type DisputeState =
  | 'OPEN'
  | 'EVIDENCE_REQUESTED'
  | 'RESOLVED'
  | 'ESCALATED';

export type UserMode = 'worker' | 'poster';

export type CertaintyTier = 'STRONG' | 'MODERATE' | 'WEAK';

export type AIJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'KILLED';

// Live Mode types (PRODUCT_SPEC §3.5)
export type LiveModeState = 'OFF' | 'ACTIVE' | 'COOLDOWN' | 'PAUSED';
export type TaskMode = 'STANDARD' | 'LIVE';

// Account status (PRODUCT_SPEC §11)
export type AccountStatus = 'ACTIVE' | 'PAUSED' | 'SUSPENDED';

// Evidence access scope (AI_INFRASTRUCTURE §9)
export type EvidenceAccessScope = 'uploader_only' | 'restricted' | 'dispute_reviewers' | 'admin_only';

// Evidence moderation status
export type EvidenceModerationStatus = 'pending' | 'approved' | 'flagged' | 'quarantined';

// Risk level for tasks
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// Task Progress State (Pillar A - Realtime Tracking)
// Authority: task.progress_state is the source of truth
// Enforced: Monotonic transitions only (no skips, no reversals)
export type TaskProgressState =
  | 'POSTED'
  | 'ACCEPTED'
  | 'TRAVELING'
  | 'WORKING'
  | 'COMPLETED'
  | 'CLOSED';

// ============================================================================
// TERMINAL STATE CONSTANTS
// ============================================================================

export const TERMINAL_TASK_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];
export const TERMINAL_ESCROW_STATES: EscrowState[] = ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'];

// Task Progress State Machine (Pillar A - Realtime Tracking)
// Valid transitions (hard-coded map)
// No skips. No reversals. No conditional branches.
export const VALID_PROGRESS_TRANSITIONS: Record<TaskProgressState, readonly TaskProgressState[]> = {
  POSTED: ['ACCEPTED'],
  ACCEPTED: ['TRAVELING'],
  TRAVELING: ['WORKING'],
  WORKING: ['COMPLETED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [],
} as const;

// ============================================================================
// CORE DOMAIN TYPES
// ============================================================================

export interface User {
  id: string;
  firebase_uid?: string;
  email: string;
  phone?: string;
  full_name: string;
  bio?: string;
  avatar_url?: string;
  
  // Role (from onboarding)
  default_mode: UserMode;
  
  // Onboarding (ONBOARDING_SPEC §7, §11)
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
  
  // Trust (PRODUCT_SPEC §8.2)
  trust_tier: number; // 1-4
  trust_hold: boolean;
  trust_hold_reason?: string;
  trust_hold_until?: Date;
  
  // XP (PRODUCT_SPEC §5)
  xp_total: number;
  current_level: number; // 1-10
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
  
  // Plan (Step 9-C - Monetization Hooks)
  plan: 'free' | 'premium' | 'pro';
  plan_subscribed_at?: Date;
  plan_expires_at?: Date;
  
  // UI preferences (ONBOARDING_SPEC §6)
  xp_visibility_rules?: string;
  trust_ui_density?: string;
  copy_tone_variant?: string;
  
  // Gamification unlock tracking
  xp_first_celebration_shown_at?: Date;
  
  // Live Mode (PRODUCT_SPEC §3.5)
  live_mode_state: LiveModeState;
  live_mode_session_started_at?: Date;
  live_mode_banned_until?: Date;
  live_mode_total_tasks: number;
  live_mode_completion_rate?: number;
  
  // Fatigue tracking (PRODUCT_SPEC §3.7)
  daily_active_minutes: number;
  last_activity_date?: Date;
  consecutive_active_days: number;
  last_mandatory_break_at?: Date;
  
  // Account pause state (PRODUCT_SPEC §11)
  account_status: AccountStatus;
  paused_at?: Date;
  pause_streak_snapshot?: number;
  pause_trust_tier_snapshot?: number;
  
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
  risk_level: RiskLevel;
  scope_hash?: string;
  
  state: TaskState;
  
  // Progress Tracking (Pillar A - Realtime Tracking)
  progress_state: TaskProgressState;
  progress_updated_at: Date;
  progress_by?: string; // UUID of user who advanced progress (null for system)
  
  // Live Mode (PRODUCT_SPEC §3.5)
  mode: TaskMode;
  live_broadcast_started_at?: Date;
  live_broadcast_expired_at?: Date;
  live_broadcast_radius_miles?: number;
  
  // Instant Execution Mode (IEM v1)
  instant_mode: boolean;
  surge_level?: number; // 0 = no surge, 1 = visibility boost, 2 = XP boost, 3 = failed
  
  // Timestamps
  deadline?: Date;
  matched_at?: Date; // Instant mode: when matching broadcast started
  accepted_at?: Date;
  proof_submitted_at?: Date;
  completed_at?: Date;
  cancelled_at?: Date;
  expired_at?: Date;
  
  // Proof requirement
  requires_proof: boolean;
  proof_instructions?: string;
  
  created_at: Date;
  updated_at: Date;
}

export interface Escrow {
  id: string;
  task_id: string;

  // Amount in USD cents (INTEGER - no floats!) - INV-4: immutable after creation
  amount: number;

  state: EscrowState;

  // Partial refund tracking (for REFUND_PARTIAL state)
  refund_amount?: number;
  release_amount?: number;

  // Stripe references
  stripe_payment_intent_id?: string;
  stripe_transfer_id?: string;
  stripe_refund_id?: string;

  // Joined from tasks table (EscrowService.getById JOINs tasks)
  poster_id?: string;
  worker_id?: string;

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
  
  description?: string;
  
  // Review
  reviewed_by?: string;
  reviewed_at?: Date;
  rejection_reason?: string;
  
  // Timestamps
  submitted_at?: Date;
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
  reason_details?: Record<string, unknown>;
  
  task_id?: string;
  dispute_id?: string;
  
  changed_by: string; // 'system', 'admin:usr_xxx'
  
  // Idempotency (MVP)
  idempotency_key: string;
  event_source: string; // 'dispute', 'task', 'admin', 'system'
  source_event_id?: string;
  
  changed_at: Date;
}

export interface Badge {
  id: string;
  user_id: string;
  badge_type: string;
  badge_tier: number; // 1-4
  
  animation_shown_at?: Date;
  
  awarded_for?: string;
  task_id?: string;
  
  awarded_at: Date;
}

export interface Dispute {
  id: string;
  task_id: string;
  escrow_id: string;
  
  // Participants
  initiated_by: string;
  poster_id: string;
  worker_id: string;
  
  state: DisputeState;
  
  // Reason
  reason: string;
  description: string;
  
  // Resolution
  resolution?: string;
  resolution_notes?: string;
  resolved_by?: string;
  resolved_at?: Date;
  
  // Outcome
  outcome_escrow_action?: 'RELEASE' | 'REFUND' | 'SPLIT';
  outcome_worker_penalty: boolean;
  outcome_poster_penalty: boolean;
  outcome_refund_amount?: number;
  outcome_release_amount?: number;
  
  // Optimistic locking
  version: number;
  
  created_at: Date;
  updated_at: Date;
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
  
  // Model info
  model_provider?: string;
  model_id?: string;
  prompt_version?: string;
  
  // Timing
  started_at?: Date;
  completed_at?: Date;
  timeout_ms: number;
  
  // Retry tracking
  attempt_count: number;
  max_attempts: number;
  last_error?: string;
  
  created_at: Date;
  updated_at: Date;
}

export interface AIProposal {
  id: string;
  job_id: string;
  
  proposal_type: string;
  proposal: Record<string, unknown>;
  proposal_hash: string;
  
  confidence?: number;
  certainty_tier?: CertaintyTier;
  anomaly_flags?: string[];
  
  schema_version: string;
  
  created_at: Date;
}

export interface AIDecision {
  id: string;
  proposal_id: string;
  
  accepted: boolean;
  reason_codes: string[];
  
  // What was written (if accepted)
  writes?: Record<string, unknown>;
  
  // Authority
  final_author: string; // 'system', 'admin:usr_xxx', 'user:usr_xxx'
  
  decided_at: Date;
}

// Evidence (AI_INFRASTRUCTURE §9)
export interface Evidence {
  id: string;
  task_id?: string;
  dispute_id?: string;
  proof_id?: string;
  
  uploader_user_id: string;
  
  // Request context
  requested_by: 'system' | 'poster' | 'admin';
  request_reason_codes: string[];
  ai_request_proposal_id?: string;
  
  // File info
  storage_key: string;
  content_type: string;
  file_size_bytes: number;
  checksum_sha256: string;
  
  // Capture metadata
  capture_time?: Date;
  device_metadata?: Record<string, unknown>;
  
  // Access control
  access_scope: EvidenceAccessScope;
  
  // Retention
  retention_deadline: Date;
  legal_hold: boolean;
  deleted_at?: Date;
  
  // Moderation
  moderation_status: EvidenceModerationStatus;
  moderation_flags?: string[];
  
  created_at: Date;
  updated_at: Date;
}

// Live Mode types
export interface LiveSession {
  id: string;
  user_id: string;
  
  started_at: Date;
  ended_at?: Date;
  end_reason?: 'MANUAL' | 'COOLDOWN' | 'FATIGUE' | 'FORCED';
  
  tasks_accepted: number;
  tasks_declined: number;
  tasks_completed: number;
  earnings_cents: number;
  
  created_at: Date;
}

export interface LiveBroadcast {
  id: string;
  task_id: string;
  
  started_at: Date;
  expired_at?: Date;
  accepted_at?: Date;
  accepted_by?: string;
  
  initial_radius_miles: number;
  final_radius_miles?: number;
  hustlers_notified: number;
  hustlers_viewed: number;
  
  created_at: Date;
}

// Poster reputation (PRODUCT_SPEC §8.4)
export interface PosterRating {
  id: string;
  task_id: string;
  poster_id: string;
  rated_by: string;
  
  rating: 'GREAT' | 'OKAY' | 'DIFFICULT';
  feedback_flags?: string[];
  
  created_at: Date;
}

// Session forecast (AI_INFRASTRUCTURE §21)
export interface SessionForecast {
  id: string;
  user_id: string;
  
  earnings_low_cents: number;
  earnings_high_cents: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  conditions: 'POOR' | 'FAIR' | 'GOOD' | 'EXCELLENT';
  best_categories?: string[];
  nearby_demand?: number;
  
  actual_earnings_cents?: number;
  
  inputs_hash?: string;
  expires_at: Date;
  
  created_at: Date;
}

// Money timeline (UI_SPEC §14)
export interface MoneyTimelineEntry {
  id: string;
  worker_id: string;
  amount_cents: number;
  escrow_state: EscrowState;
  released_at?: Date;
  task_id: string;
  task_title: string;
  task_state: TaskState;
  timeline_category: 'TODAY' | 'AVAILABLE' | 'COMING_SOON' | 'BLOCKED' | 'PENDING';
  status_context?: string;
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

// ============================================================================
// ERROR CODES CATALOG
//
// All error codes in the system with HTTP status mappings and descriptions.
// Frontend uses code for programmatic handling, message for user display.
//
// Ranges:
//   HX0XX — State machine / terminal state violations
//   HX1XX — XP / ledger invariants
//   HX2XX — Escrow invariants
//   HX3XX — Proof invariants
//   HX4XX — Badge / gamification
//   HX6XX — Human systems (fatigue, reputation)
//   HX8XX — Admin audit
//   HX9XX — Live Mode
//   General — HTTP-aligned general errors
//   External — Third-party service errors (Stripe, AI, etc.)
// ============================================================================

export const ErrorCodes = {
  // --- Instant Mode --------------------------------------------------------
  INSTANT_TASK_INCOMPLETE: 'INSTANT_TASK_INCOMPLETE',
  INSTANT_TASK_TRUST_INSUFFICIENT: 'INSTANT_TASK_TRUST_INSUFFICIENT',

  // --- Terminal state violations (HX0XX) -----------------------------------
  TASK_TERMINAL: 'HX001',       // Task already in terminal state
  ESCROW_TERMINAL: 'HX002',     // Escrow already in terminal state

  // --- INV-4: Escrow amount immutable (HX0XX) -----------------------------
  INV_4_VIOLATION: 'HX004',     // Escrow amount modification blocked

  // --- INV-1: XP requires RELEASED escrow (HX1XX) -------------------------
  INV_1_VIOLATION: 'HX101',     // XP award without released escrow
  XP_LEDGER_DELETE: 'HX102',    // XP ledger deletion blocked (append-only)

  // --- INV-2: RELEASED requires COMPLETED task (HX2XX) --------------------
  INV_2_VIOLATION: 'HX201',     // Escrow release without completed task

  // --- INV-3: COMPLETED requires ACCEPTED proof (HX3XX) -------------------
  INV_3_VIOLATION: 'HX301',     // Task complete without accepted proof

  // --- Badge system (HX4XX) -----------------------------------------------
  BADGE_DELETE: 'HX401',        // Badge deletion blocked (append-only)

  // --- Human Systems (HX6XX) ----------------------------------------------
  FATIGUE_BYPASS: 'HX601',      // Fatigue mandatory break bypass attempt
  PAUSE_VIOLATION: 'HX602',     // Pause state violation
  POSTER_REP_ACCESS: 'HX603',   // Poster reputation access by poster
  PERCENTILE_EXPOSURE: 'HX604', // Percentile public exposure blocked

  // --- Admin actions (HX8XX) ----------------------------------------------
  ADMIN_ACTION_DELETE: 'HX801', // Admin action audit deletion blocked

  // --- Live Mode (HX9XX) --------------------------------------------------
  LIVE_1_VIOLATION: 'HX901',    // Live broadcast without funded escrow
  LIVE_2_VIOLATION: 'HX902',    // Live task below price floor
  LIVE_NOT_ACTIVE: 'HX903',     // Hustler not in ACTIVE state
  LIVE_TOGGLE_COOLDOWN: 'HX904',// Live Mode toggle cooldown active
  LIVE_BANNED: 'HX905',         // Live Mode banned

  // --- INV-5: XP idempotent per escrow (PostgreSQL unique violation) ------
  INV_5_VIOLATION: '23505',     // Unique constraint (one XP per escrow)

  // --- General errors (HTTP-aligned) --------------------------------------
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PREFERENCE_DISABLED: 'PREFERENCE_DISABLED',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- External service errors (circuit breaker aware) --------------------
  STRIPE_NOT_CONFIGURED: 'STRIPE_NOT_CONFIGURED',
  STRIPE_ERROR: 'STRIPE_ERROR',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_ALL_PROVIDERS_FAILED: 'AI_ALL_PROVIDERS_FAILED',
  REKOGNITION_NOT_CONFIGURED: 'REKOGNITION_NOT_CONFIGURED',
  BIOMETRIC_ANALYSIS_FAILED: 'BIOMETRIC_ANALYSIS_FAILED',
  SENDGRID_ERROR: 'SENDGRID_ERROR',
  TWILIO_ERROR: 'TWILIO_ERROR',
  GEOCODING_ERROR: 'GEOCODING_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
} as const;

/** Map error codes → HTTP status codes for consistent API responses */
export const ErrorCodeHttpStatus: Record<string, number> = {
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.INVALID_INPUT]: 400,
  [ErrorCodes.INVALID_STATE]: 409,
  [ErrorCodes.INVALID_TRANSITION]: 409,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCodes.SERVICE_UNAVAILABLE]: 503,
  [ErrorCodes.CIRCUIT_OPEN]: 503,
  [ErrorCodes.INTERNAL_ERROR]: 500,
  // Invariant violations are always 409 Conflict
  [ErrorCodes.TASK_TERMINAL]: 409,
  [ErrorCodes.ESCROW_TERMINAL]: 409,
  [ErrorCodes.INV_1_VIOLATION]: 409,
  [ErrorCodes.INV_2_VIOLATION]: 409,
  [ErrorCodes.INV_3_VIOLATION]: 409,
  [ErrorCodes.INV_4_VIOLATION]: 409,
  [ErrorCodes.INV_5_VIOLATION]: 409,
  // External services
  [ErrorCodes.STRIPE_NOT_CONFIGURED]: 503,
  [ErrorCodes.STRIPE_ERROR]: 502,
  [ErrorCodes.AI_UNAVAILABLE]: 503,
  [ErrorCodes.AI_ALL_PROVIDERS_FAILED]: 502,
  [ErrorCodes.SENDGRID_ERROR]: 502,
  [ErrorCodes.TWILIO_ERROR]: 502,
};
