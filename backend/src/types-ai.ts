import type {
  AIJobStatus,
  CertaintyTier,
  EscrowState,
  EvidenceAccessScope,
  EvidenceModerationStatus,
  TaskState,
} from './types-state.js';

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
  model_provider?: string;
  model_id?: string;
  prompt_version?: string;
  started_at?: Date;
  completed_at?: Date;
  timeout_ms: number;
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
  writes?: Record<string, unknown>;
  final_author: string;
  decided_at: Date;
}

export interface Evidence {
  id: string;
  task_id?: string;
  dispute_id?: string;
  proof_id?: string;
  uploader_user_id: string;
  requested_by: 'system' | 'poster' | 'admin';
  request_reason_codes: string[];
  ai_request_proposal_id?: string;
  storage_key: string;
  content_type: string;
  file_size_bytes: number;
  checksum_sha256: string;
  capture_time?: Date;
  device_metadata?: Record<string, unknown>;
  access_scope: EvidenceAccessScope;
  retention_deadline: Date;
  legal_hold: boolean;
  deleted_at?: Date;
  moderation_status: EvidenceModerationStatus;
  moderation_flags?: string[];
  created_at: Date;
  updated_at: Date;
}

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

export interface PosterRating {
  id: string;
  task_id: string;
  poster_id: string;
  rated_by: string;
  rating: 'GREAT' | 'OKAY' | 'DIFFICULT';
  feedback_flags?: string[];
  created_at: Date;
}

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
