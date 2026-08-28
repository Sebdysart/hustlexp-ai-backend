/** Public type facade plus core database-domain records. */
import type {
  AccountStatus,
  CertaintyTier,
  DisputeState,
  EscrowState,
  LiveModeState,
  ProofState,
  RiskLevel,
  TaskMode,
  TaskProgressState,
  TaskState,
  UserMode,
} from './types-state.js';

export * from './types-state.js';
export * from './types-ai.js';
export * from './types-errors.js';

export interface User {
  id: string;
  firebase_uid?: string;
  email: string;
  phone?: string;
  full_name: string;
  bio?: string;
  avatar_url?: string;
  default_mode: UserMode;
  date_of_birth?: Date | string;
  is_minor?: boolean;
  onboarding_version?: string;
  onboarding_completed_at?: Date;
  role_confidence_worker?: number;
  role_confidence_poster?: number;
  role_certainty_tier?: CertaintyTier;
  role_was_overridden: boolean;
  inconsistency_flags?: string[];
  risk_tolerance?: number;
  urgency_bias?: number;
  authority_expectation?: number;
  price_sensitivity?: number;
  trust_tier: number;
  trust_hold: boolean;
  trust_hold_reason?: string;
  trust_hold_until?: Date;
  xp_total: number;
  current_level: number;
  current_streak: number;
  last_task_completed_at?: Date;
  streak_grace_expires_at?: Date;
  is_verified: boolean;
  verified_at?: Date;
  identity_verification_status?: string;
  identity_verification_environment?: 'PRODUCTION' | 'CONTROLLED_TEST';
  identity_verification_case_id?: string;
  identity_verification_expires_at?: Date;
  identity_verification_policy_version?: string;
  student_id_verified: boolean;
  is_banned?: boolean;
  is_admin?: boolean;
  stripe_customer_id?: string;
  stripe_connect_id?: string;
  plan: 'free' | 'premium' | 'pro';
  plan_subscribed_at?: Date;
  plan_expires_at?: Date;
  xp_visibility_rules?: string;
  trust_ui_density?: string;
  copy_tone_variant?: string;
  xp_first_celebration_shown_at?: Date;
  live_mode_state: LiveModeState;
  live_mode_session_started_at?: Date;
  live_mode_banned_until?: Date;
  live_mode_total_tasks: number;
  live_mode_completion_rate?: number;
  daily_active_minutes: number;
  last_activity_date?: Date;
  consecutive_active_days: number;
  last_mandatory_break_at?: Date;
  account_status: AccountStatus;
  paused_at?: Date;
  pause_streak_snapshot?: number;
  pause_trust_tier_snapshot?: number;
  created_at: Date;
  updated_at: Date;
}

export interface Task {
  id: string;
  version?: number;
  poster_id: string;
  worker_id?: string;
  title: string;
  description: string;
  requirements?: string;
  location?: string;
  rough_location?: string;
  idempotency_replayed?: boolean;
  completion_idempotency_replayed?: boolean;
  category?: string;
  price: number;
  hustler_payout_cents?: number;
  platform_margin_cents?: number;
  repeat_source_task_id?: string;
  preferred_worker_id?: string;
  retention_conversion?: 'REBOOK';
  risk_level: RiskLevel;
  scope_hash?: string;
  active_scope_version_id?: string;
  state: TaskState;
  progress_state: TaskProgressState;
  progress_updated_at: Date;
  progress_by?: string;
  mode: TaskMode;
  live_broadcast_started_at?: Date;
  live_broadcast_expired_at?: Date;
  live_broadcast_radius_miles?: number;
  instant_mode: boolean;
  surge_level?: number;
  deadline?: Date;
  matched_at?: Date;
  accepted_at?: Date;
  proof_submitted_at?: Date;
  completed_at?: Date;
  cancelled_at?: Date;
  expired_at?: Date;
  dispatch_expires_at?: Date;
  expiration_reason?: 'UNFILLED' | 'DEADLINE';
  refund_state?: 'NOT_REQUIRED' | 'PENDING' | 'REFUNDED' | 'BLOCKED';
  refund_blocker?: string;
  refund_requested_at?: Date;
  started_at?: Date;
  completion_message_delivered_at?: Date;
  completion_message_delivery_id?: string;
  completion_confirmed_at?: Date;
  payout_ready_at?: Date;
  payout_ready_reason?: string;
  requires_proof: boolean;
  trust_tier_required?: number;
  completion_criteria?: { type: string };
  content_release?: boolean;
  mutual_consent_required?: boolean;
  mutual_consent_accepted?: boolean;
  cancellation_window_hours?: number;
  late_cancel_pct?: number;
  cancellation_policy_version?: string;
  proof_instructions?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Escrow {
  id: string;
  task_id: string;
  version: number;
  amount: number;
  platform_fee_cents?: number;
  state: EscrowState;
  refund_amount?: number;
  release_amount?: number;
  stripe_payment_intent_id?: string;
  stripe_transfer_id?: string;
  stripe_refund_id?: string;
  payout_provider?: 'STRIPE' | 'LOCAL_CERTIFICATION_TEST' | 'MANUAL_RECONCILIATION';
  provider_transfer_id?: string;
  provider_transfer_status?: 'submitted' | 'processing' | 'paid' | 'manual_reconciliation';
  provider_transfer_paid_at?: Date;
  poster_id?: string;
  worker_id?: string;
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
  client_submission_id?: string;
  submission_hash?: string;
  sync_contract_version?: number;
  client_sequence?: number;
  prior_task_version?: number;
  local_occurred_at?: Date;
  device_version?: string;
  app_version?: string;
  idempotency_replayed?: boolean;
  scope_version_id?: string;
  scope_version_hash?: string;
  reviewed_by?: string;
  reviewed_at?: Date;
  rejection_reason?: string;
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

export interface ProofVideo {
  id: string;
  proof_id: string;
  storage_key: string;
  content_type: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
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
  changed_by: string;
  idempotency_key: string;
  event_source: string;
  source_event_id?: string;
  changed_at: Date;
}

export interface Badge {
  id: string;
  user_id: string;
  badge_type: string;
  badge_tier: number;
  animation_shown_at?: Date;
  awarded_for?: string;
  task_id?: string;
  awarded_at: Date;
}

export interface Dispute {
  id: string;
  task_id: string;
  escrow_id: string;
  initiated_by: string;
  poster_id: string;
  worker_id: string;
  state: DisputeState;
  reason: string;
  description: string;
  resolution?: string;
  resolution_notes?: string;
  resolved_by?: string;
  resolved_at?: Date;
  outcome_escrow_action?: 'RELEASE' | 'REFUND' | 'SPLIT';
  outcome_worker_penalty: boolean;
  outcome_poster_penalty: boolean;
  outcome_refund_amount?: number;
  outcome_release_amount?: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}
