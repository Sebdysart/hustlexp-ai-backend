import type { TaskRiskLevel } from './TaskServiceShared.js';

export type RecurringPattern = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface ControlledRecurringTemplateInput {
  posterId: string;
  clientPrincipalType: 'HOUSEHOLD' | 'ORGANIZATION';
  clientPrincipalId: string;
  title: string;
  description: string;
  category: string;
  taskRecipe: Record<string, unknown>;
  exactLocation: string;
  roughLocation: string;
  accessProcedure: string;
  regionCode: string;
  riskLevel: TaskRiskLevel;
  pattern: RecurringPattern;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timeOfDay: string;
  startDate: string;
  endDate: string | null;
  timezone: string;
  serviceWindowStart: string;
  serviceWindowEnd: string;
  expectedDurationMinutes: number;
  customerTotalCents: number;
  providerPayoutCents: number;
  platformMarginCents: number;
  corridorMinimumCents: number;
  corridorMaximumCents: number;
  maximumAdjustmentCents: number;
  requiredTrustTier: number;
  licenseRequirements: Record<string, unknown>;
  insuranceRequirements: Record<string, unknown>;
  credentialsValidUntil: string | null;
  requiredTools: string[];
  requiredVehicle: string | null;
  completionChecklist: string[];
  preferredWorkerId: string | null;
  backupWorkerIds: string[];
  cancellationRules: Record<string, unknown>;
  holidayRules: Record<string, unknown>;
  budgetCapCents: number;
  approverId: string;
  escalationRules: Record<string, unknown>;
  invoiceGrouping: Record<string, unknown>;
  nextReviewDate: string;
  businessOrganizationId?: string | null;
  businessLocationId?: string | null;
  recurringPoNumber?: string | null;
  recurringCostCenter?: string | null;
  businessAutoApproveLimitCents?: number | null;
}

export interface ControlledSeriesRow {
  id: string;
  poster_id: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  current_revision_id: string;
  next_occurrence_at: string;
  end_date: string | null;
  title: string;
  description: string;
  category: string;
  region_code: string;
  risk_level?: TaskRiskLevel;
  rough_location: string;
  payment_cents: number;
  provider_payout_cents: number;
  platform_margin_cents: number;
  expected_duration_minutes: number;
  required_tools: string[];
  completion_checklist: string[];
  preferred_worker_id: string | null;
  backup_worker_ids: string[];
  pattern: RecurringPattern;
  occurrence_count: number;
  service_window_start: string;
  service_window_end: string;
  timezone: string;
  location_ciphertext: string | null;
  location_nonce: string | null;
  location_auth_tag: string | null;
  location_key_id: string | null;
  access_ciphertext: string | null;
  access_nonce: string | null;
  access_auth_tag: string | null;
  access_key_id: string | null;
  client_principal_type: 'HOUSEHOLD' | 'ORGANIZATION';
  business_organization_id: string | null;
  business_location_id: string | null;
  recurring_po_number: string | null;
  recurring_cost_center: string | null;
  holiday_rules: Record<string, unknown>;
}

export interface GenerateControlledOccurrenceInput {
  seriesId: string;
  actorId: string | null;
  evaluateAt?: Date;
  lookaheadHours?: number;
}

export interface ControlledRecurringTemplateSummary {
  id: string;
  title: string;
  category: string;
  roughLocation: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  pauseCode: string | null;
  currentRevisionId: string;
  nextOccurrenceAt: string;
  pattern: RecurringPattern;
  serviceWindowStart: string;
  serviceWindowEnd: string;
  timezone: string;
  budgetCapCents: number;
  budgetSpendCents: number;
  preferredWorkerId: string | null;
  backupProviderCount: number;
  occurrenceCount: number;
  completedCount: number;
  automationMode: string;
}

export interface ControlledOccurrenceResult {
  outcome: 'generated' | 'replayed' | 'paused' | 'not_due' | 'approval_required' | 'skipped' | 'completed';
  taskId?: string;
  occurrenceId?: string;
  occurrenceNumber?: number;
  pauseCode?: string;
  approvalRequestId?: string;
  scheduleExceptionId?: string;
}
