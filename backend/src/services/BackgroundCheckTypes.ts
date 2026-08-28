import type { ScreeningProvider } from './WorkerScreeningRightsPolicy.js';

export type BackgroundCheckStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'CLEAR'
  | 'CONSIDER'
  | 'FAILED'
  | 'EXPIRED';

export interface BackgroundCheckRow {
  id: string;
  user_id: string;
  provider: string;
  check_id: string;
  status: BackgroundCheckStatus;
  initiated_at: string;
  completed_at: string | null;
  expires_at: string | null;
  result_summary: string | null;
  details: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  provider_environment: 'PRODUCTION' | 'CONTROLLED_TEST';
  is_test: boolean;
}

export interface BackgroundCheck {
  id: string;
  userId: string;
  provider: string;
  checkId: string;
  status: BackgroundCheckStatus;
  initiatedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  resultSummary: string | null;
  details: Record<string, unknown> | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
  providerEnvironment: 'PRODUCTION' | 'CONTROLLED_TEST';
  isTest: boolean;
}

export interface BackgroundCheckInitiation {
  userId: string;
  provider: ScreeningProvider;
  consentId: string;
  ssnLast4?: string;
  dateOfBirth?: string;
  fullName?: string;
}

export function backgroundCheckFromRow(row: BackgroundCheckRow): BackgroundCheck {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
    providerEnvironment: row.provider_environment,
    isTest: row.is_test,
  };
}
