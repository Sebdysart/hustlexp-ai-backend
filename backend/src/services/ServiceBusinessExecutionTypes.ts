import type { WorkerOfferDecision } from './WorkerOfferDecisionPolicy.js';

export interface ServiceBusinessOpportunityRow {
  task_id: string;
  title: string;
  description: string;
  requirements: string | null;
  category: string;
  customer_total_cents: number | string;
  payout_cents: number | string;
  platform_margin_cents: number | string;
  estimated_duration_minutes: number;
  required_tools: string[];
  rough_location: string;
  risk_level: string;
  scope_hash: string;
  cancellation_policy_version: string;
  late_cancel_pct: number;
  cancellation_window_hours: number;
  deadline: string | Date | null;
  service_profile_id: string;
  service_name: string;
  maximum_travel_miles: number;
  minimum_provider_net_hourly_cents: number;
  provider_earnings_policy_version: string;
  eligible_crew_count: number | string;
}

export interface ServiceBusinessOpportunity {
  taskId: string;
  serviceProfileId: string;
  serviceName: string;
  title: string;
  category: string;
  roughLocation: string;
  customerTotalCents: number;
  payoutCents: number;
  estimatedDurationMinutes: number;
  requiredTools: string[];
  riskLevel: string;
  travel: { minimumMiles: 0; maximumMiles: number; estimateKind: 'SERVICE_ZONE_RANGE' };
  rankReasons: string[];
  eligibleCrewCount: number;
}

export interface ServiceBusinessEligibleCrew {
  crewAssignmentId: string;
  fulfillerName: string;
  memberRole: 'CREW' | 'DISPATCHER' | 'ADMIN' | 'OWNER';
}

export interface ServiceBusinessAssignment {
  taskId: string;
  title: string;
  category: string;
  roughLocation: string;
  taskState: string;
  progressState: string;
  fulfillerName: string;
  grossPayoutCents: number;
  payoutState:
    | 'NOT_AVAILABLE'
    | 'PENDING_CLEARANCE'
    | 'CONNECTED_BALANCE_CONFIRMED'
    | 'HELD'
    | 'PARTIALLY_SETTLED_OR_REFUNDED'
    | 'REFUNDED_OR_REVERSED';
  payoutDestination: { kind: 'ORGANIZATION_ACCOUNT' };
  acceptedAt: string;
  completedAt: string | null;
}

export interface ServiceBusinessOfferReview {
  offerDecisionId: string;
  crewAssignmentId: string;
  fulfillerName: string;
  payoutDestination: {
    kind: 'ORGANIZATION_ACCOUNT';
    state: 'ACTIVE';
  };
  decision: WorkerOfferDecision;
  expiresAt: string;
  idempotencyReplayed: boolean;
}

export interface ServiceBusinessQuoteResult {
  action: 'QUOTED';
  counterOfferId: string;
  proposedCustomerTotalCents: number;
  proposedPayoutCents: number;
  requiresPaymentReauthorization: boolean;
  idempotencyReplayed: boolean;
}
