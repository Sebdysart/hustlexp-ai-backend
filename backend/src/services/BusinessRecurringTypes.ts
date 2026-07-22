import type {
  ControlledRecurringTemplateSummary,
  RecurringPattern,
} from './RecurringWorkService.js';

export type BusinessRecurringSource = {
  location_id: string;
  rough_location: string;
  region_code: string;
  timezone: string;
  exact_address_ciphertext: string;
  exact_address_nonce: string;
  exact_address_auth_tag: string;
  exact_address_key_id: string;
  access_ciphertext: string;
  access_nonce: string;
  access_auth_tag: string;
  access_key_id: string;
  per_task_cap_cents: number | string | null;
  monthly_cap_cents: number | string | null;
  auto_approve_limit_cents: number | string | null;
  po_required: boolean | null;
  cost_center_required: boolean | null;
  preferred_worker_id: string | null;
  backup_worker_ids: string[];
};

export interface CreateBusinessRecurringTemplateInput {
  actorId: string;
  organizationId: string;
  locationId: string;
  title: string;
  description: string;
  category: string;
  pattern: RecurringPattern;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timeOfDay: string;
  startDate: string;
  endDate: string | null;
  serviceWindowStart: string;
  serviceWindowEnd: string;
  expectedDurationMinutes: number;
  amountCents: number;
  templateBudgetCapCents: number;
  poNumber: string | null;
  costCenter: string | null;
  requiredTools: string[];
  proofChecklist: string[];
  blackoutDates: string[];
  cancellationNoticeHours: number;
  nextReviewDate: string;
  insideHome: boolean;
  peoplePresent: boolean;
  petsPresent: boolean;
  caregiving: boolean;
}

export interface BusinessRecurringTemplateSummary extends ControlledRecurringTemplateSummary {
  locationId: string;
  approvalMode: 'AUTO_ELIGIBLE' | 'PER_OCCURRENCE_APPROVAL';
}
