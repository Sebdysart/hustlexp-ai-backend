export type MajorActionClass =
  | 'INTENT_SCOPE'
  | 'PRICING_QUOTE'
  | 'PAYMENT'
  | 'DISPATCH'
  | 'OFFER_ASSIGNMENT'
  | 'EXECUTION'
  | 'PROOF_COMPLETION'
  | 'SETTLEMENT'
  | 'PAYOUT'
  | 'DISPUTE'
  | 'SAFETY'
  | 'TRUST_IDENTITY'
  | 'BUSINESS_OPERATION'
  | 'RECURRING_WORK'
  | 'RECOMMENDATION'
  | 'AUTOMATION'
  | 'NOTIFICATION'
  | 'OFFLINE_SYNC'
  | 'LIQUIDITY';

export type AutomationClass = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5';
export type MajorActionActorRole =
  | 'VISITOR'
  | 'POSTER'
  | 'HUSTLER'
  | 'BUSINESS'
  | 'OPERATOR'
  | 'SYSTEM'
  | 'PROVIDER'
  | 'USER';
export type MajorActionSyncState =
  | 'SERVER_CONFIRMED'
  | 'LOCAL_PENDING'
  | 'SYNCING'
  | 'CONFLICT'
  | 'REJECTED';
export type MajorActionResult =
  | 'SUCCESS'
  | 'FAILURE'
  | 'PARTIAL'
  | 'NOOP'
  | 'QUEUED'
  | 'REJECTED'
  | 'CONFLICT';
export type Applicability = 'APPLIED' | 'NOT_APPLICABLE' | 'UNATTRIBUTED';

export interface MajorActionRecordInput {
  eventName: string;
  eventVersion?: number;
  actionClass: MajorActionClass;
  automationClass: AutomationClass;
  actorRole: MajorActionActorRole;
  actorRef: string;
  aggregateType: string;
  aggregateId: string;
  previousLifecycleState: string;
  lifecycleState: string;
  syncState: MajorActionSyncState;
  entrySurface: string;
  contextSource: string;
  policyVersion: string;
  policyApplicability: Applicability;
  recommendationId?: string | null;
  modelVersion: string;
  modelApplicability: Applicability;
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  correlationId: string;
  causationId: string;
  idempotencyKey: string;
  sourceSequence?: number | null;
  result: MajorActionResult;
  failureReasonCode?: string | null;
  recoveryActionCode?: string | null;
  changeReasonCode: string;
  experimentVariant?: string;
  experimentApplicable?: boolean;
  reversible: boolean;
  sourceTable: string;
  sourceEventId: string;
  occurredAt: string;
}

export interface MajorActionOutcomeInput {
  majorActionEventId: string;
  outcomeType: string;
  outcomeObjectType: string;
  outcomeObjectId: string;
  realizedResult: 'CONFIRMED' | 'FAILED' | 'REVERSED' | 'REFUNDED' | 'HELD' | 'NOT_REALIZED';
  realizedAmountCents?: number | null;
  currency?: 'usd' | null;
  sourceTable: string;
  sourceEventId: string;
  measuredAt: string;
}
