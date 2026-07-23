export interface ServiceBusinessReservationContext {
  organizationId: string;
  serviceProfileId: string;
  crewAssignmentId: string;
  offerDecisionId: string;
}

export interface ReserveTaskParams {
  engineTaskId: string;
  hustlerRef: string;
  idempotencyKey: string;
  actorId: string;
  serviceBusiness?: ServiceBusinessReservationContext;
}

export interface EngineReservationResult {
  reservationId: string;
  engineTaskId: string;
  hustlerRef: string;
  state: 'ENGINE_RESERVED';
  idempotencyReplayed: boolean;
}

export interface TaskReservationRow {
  id: string;
  state: string;
  worker_id: string | null;
  poster_id: string;
  risk_level: string;
  sensitive: boolean | null;
  price: number;
  trust_tier_required: number | null;
  escrow_state: string | null;
  automation_classification: string | null;
  background_check_required: boolean;
  liquidity_cell_id: string | null;
  liquidity_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  liquidity_is_test: boolean | null;
  local_test_liquidity_ready: boolean;
  offer_decision_ready: boolean;
}

export interface WorkerReservationRow {
  id: string;
  default_mode: string;
  trust_tier: number;
  trust_hold: boolean;
  active_trust_hold: boolean;
  is_banned: boolean | null;
  is_minor: boolean;
  account_status: string;
  plan: string;
  stripe_connect_id: string | null;
  payouts_enabled: boolean;
  local_test_payout_ready: boolean;
  background_check_valid: boolean;
  background_check_expires_at: Date | string | null;
  background_check_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  background_check_is_test: boolean;
  background_check_source_ready: boolean;
}

export interface ReservationError {
  kind: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReservationSuccess {
  kind: 'success';
  reservationId: string;
  replayed: boolean;
}

export function reservationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ReservationError {
  return { kind: 'error', code, message, details };
}
