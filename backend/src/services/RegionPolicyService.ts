import { z } from 'zod';
import { db } from '../db.js';

const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'IN_HOME']);

const CredentialsSchema = z.object({
  licenseRequired: z.boolean(),
  insuranceRequired: z.boolean(),
  backgroundCheckRequired: z.boolean(),
}).strict();

const EvidenceSchema = z.object({
  proofRequired: z.boolean(),
  minPhotos: z.number().int().min(1).max(5),
  maxPhotos: z.number().int().min(1).max(5),
  gpsRequired: z.boolean(),
}).strict().refine((value) => value.minPhotos <= value.maxPhotos, {
  message: 'minimum proof photos cannot exceed the maximum',
});

const CategoryPolicySchema = z.object({
  allowedRiskLevels: z.array(RiskLevelSchema).min(1),
  credentials: CredentialsSchema,
  evidence: EvidenceSchema,
}).strict();

export const RegionPolicyDocumentSchema = z.object({
  schemaVersion: z.literal('hxos-region-policy-v1'),
  categories: z.record(CategoryPolicySchema).refine((categories) => Object.keys(categories).length > 0, {
    message: 'at least one category policy is required',
  }),
  recording: z.object({
    allowed: z.boolean(),
    standaloneConsentRequired: z.boolean(),
  }).strict(),
  workerRights: z.object({
    standaloneScreeningConsentRequired: z.boolean(),
    reportAccessRequired: z.boolean(),
    disputeAndAppealRequired: z.boolean(),
    adverseActionNoticeRequired: z.boolean(),
  }).strict(),
  financial: z.object({
    currency: z.literal('usd'),
    minimumCustomerCents: z.number().int().positive(),
    minimumPayoutCents: z.number().int().positive(),
    minimumMarginCents: z.number().int().nonnegative(),
  }).strict(),
  safety: z.object({
    incidentIntakeRequired: z.boolean(),
    timedCheckinRiskLevels: z.array(RiskLevelSchema),
    checkinIntervalsMinutes: z.array(z.union([z.literal(15), z.literal(30), z.literal(60)]))
      .min(1).refine((values) => new Set(values).size === values.length, { message: 'check-in intervals must be unique' }),
    locationRetentionDays: z.number().int().min(1).max(30),
    alternateEmergencyActionRequired: z.boolean(),
  }).strict(),
}).strict();

export type RegionPolicyDocument = z.infer<typeof RegionPolicyDocumentSchema>;

export interface RegionPolicyRow {
  id: string;
  region_code: string;
  version: string;
  policy_hash: string;
  production_enabled: boolean;
  effective_from: string | Date;
  effective_until: string | Date | null;
  legal_approval_effective_at?: string | Date | null;
  legal_approval_review_at?: string | Date | null;
  policy_document: RegionPolicyDocument;
}

export interface RegionPolicyTaskInput {
  regionCode: string;
  automationClassification: 'PRODUCTION' | 'CONTROLLED_TEST';
  category: string;
  riskLevel: z.infer<typeof RiskLevelSchema>;
  requiresProof: boolean;
  customerTotalCents: number;
  payoutCents: number | null;
  marginCents: number | null;
}

export interface RegionPolicyTaskSnapshot {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  regionCode: string;
  locationState: string;
  licenseRequired: boolean;
  insuranceRequired: boolean;
  backgroundCheckRequired: boolean;
  proofRequired: boolean;
  proofMinPhotos: number;
  proofMaxPhotos: number;
  proofGpsRequired: boolean;
  recordingAllowed: boolean;
  recordingStandaloneConsentRequired: boolean;
  screeningStandaloneConsentRequired: boolean;
  screeningReportAccessRequired: boolean;
  screeningDisputeAndAppealRequired: boolean;
  screeningAdverseActionNoticeRequired: boolean;
  safetyIncidentIntakeRequired: boolean;
  safetyTimedCheckinRequired: boolean;
  safetyCheckinIntervalsMinutes: Array<15 | 30 | 60>;
  safetyLocationRetentionDays: number;
  safetyAlternateEmergencyActionRequired: boolean;
  currency: 'usd';
}

export type RegionPolicyEvaluation =
  | { allowed: true; reasons: []; snapshot: RegionPolicyTaskSnapshot }
  | { allowed: false; reasons: string[]; snapshot: null };

const PolicyIdentitySchema = z.object({
  id: z.string().uuid(),
  region_code: z.string().regex(/^US-[A-Z]{2}$/),
  version: z.string().trim().min(1).max(120),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
  production_enabled: z.boolean(),
}).strict();

function locationState(regionCode: string): string | null {
  const match = /^US-([A-Z]{2})$/.exec(regionCode);
  return match?.[1] ?? null;
}

function financialPolicyReasons(
  financial: RegionPolicyDocument['financial'],
  task: RegionPolicyTaskInput,
): string[] {
  const reasons: string[] = [];
  if (!Number.isInteger(task.customerTotalCents) || task.customerTotalCents < financial.minimumCustomerCents) {
    reasons.push('customer_total_below_region_floor');
  }
  if (!Number.isInteger(task.payoutCents) || (task.payoutCents ?? 0) < financial.minimumPayoutCents) {
    reasons.push('payout_below_region_floor');
  }
  if (!Number.isInteger(task.marginCents) || (task.marginCents ?? -1) < financial.minimumMarginCents) {
    reasons.push('margin_below_region_floor');
  }
  return reasons;
}

function taskPolicyReasons(
  row: RegionPolicyRow,
  document: RegionPolicyDocument,
  task: RegionPolicyTaskInput,
  state: string | null,
  now: Date,
): string[] {
  const reasons: string[] = [];
  if (task.automationClassification === 'PRODUCTION' && !row.production_enabled) {
    reasons.push('production_policy_not_approved');
  }
  if (task.automationClassification === 'PRODUCTION' && row.production_enabled) {
    const effectiveAt = new Date(row.legal_approval_effective_at ?? Number.NaN);
    const reviewAt = new Date(row.legal_approval_review_at ?? Number.NaN);
    if (
      Number.isNaN(effectiveAt.valueOf()) ||
      Number.isNaN(reviewAt.valueOf()) ||
      effectiveAt > now ||
      reviewAt <= now
    ) {
      reasons.push('production_legal_approval_unavailable');
    }
  }
  if (task.regionCode !== row.region_code) reasons.push('region_policy_mismatch');
  if (!state) reasons.push('region_policy_invalid');
  const category = document.categories[task.category];
  if (!category) reasons.push('category_not_allowed');
  if (category && !category.allowedRiskLevels.includes(task.riskLevel)) reasons.push('risk_level_not_allowed');
  if (category?.evidence.proofRequired && !task.requiresProof) reasons.push('proof_required');
  return [...reasons, ...financialPolicyReasons(document.financial, task)];
}

function taskPolicySnapshot(
  row: RegionPolicyRow,
  document: RegionPolicyDocument,
  task: RegionPolicyTaskInput,
  state: string,
): RegionPolicyTaskSnapshot {
  const category = document.categories[task.category];
  if (!category) throw new TypeError('Validated region category is unexpectedly absent.');
  const rights = document.workerRights;
  const safety = document.safety;
  return {
    policyId: row.id,
    policyVersion: row.version,
    policyHash: row.policy_hash,
    regionCode: row.region_code,
    locationState: state,
    licenseRequired: category.credentials.licenseRequired,
    insuranceRequired: category.credentials.insuranceRequired,
    backgroundCheckRequired: category.credentials.backgroundCheckRequired,
    proofRequired: category.evidence.proofRequired,
    proofMinPhotos: category.evidence.minPhotos,
    proofMaxPhotos: category.evidence.maxPhotos,
    proofGpsRequired: category.evidence.gpsRequired,
    recordingAllowed: document.recording.allowed,
    recordingStandaloneConsentRequired: document.recording.standaloneConsentRequired,
    screeningStandaloneConsentRequired: rights.standaloneScreeningConsentRequired,
    screeningReportAccessRequired: rights.reportAccessRequired,
    screeningDisputeAndAppealRequired: rights.disputeAndAppealRequired,
    screeningAdverseActionNoticeRequired: rights.adverseActionNoticeRequired,
    safetyIncidentIntakeRequired: safety.incidentIntakeRequired,
    safetyTimedCheckinRequired: safety.timedCheckinRiskLevels.includes(task.riskLevel),
    safetyCheckinIntervalsMinutes: [...safety.checkinIntervalsMinutes],
    safetyLocationRetentionDays: safety.locationRetentionDays,
    safetyAlternateEmergencyActionRequired: safety.alternateEmergencyActionRequired,
    currency: document.financial.currency,
  };
}

export function evaluateTaskAgainstRegionPolicy(
  row: RegionPolicyRow,
  task: RegionPolicyTaskInput,
  now: Date = new Date(),
): RegionPolicyEvaluation {
  const identity = PolicyIdentitySchema.safeParse({
    id: row.id,
    region_code: row.region_code,
    version: row.version,
    policy_hash: row.policy_hash,
    production_enabled: row.production_enabled,
  });
  const document = RegionPolicyDocumentSchema.safeParse(row.policy_document);
  if (!identity.success || !document.success) {
    return { allowed: false, reasons: ['region_policy_invalid'], snapshot: null };
  }
  const state = locationState(row.region_code);
  const reasons = taskPolicyReasons(row, document.data, task, state, now);
  if (reasons.length > 0 || !state) {
    return { allowed: false, reasons: [...new Set(reasons)], snapshot: null };
  }
  return {
    allowed: true,
    reasons: [],
    snapshot: taskPolicySnapshot(row, document.data, task, state),
  };
}

export async function resolveRegionPolicy(regionCode: string): Promise<RegionPolicyRow | null> {
  const result = await db.query<RegionPolicyRow>(
    `SELECT policy.id, policy.region_code, policy.version, policy.policy_hash,
            policy.production_enabled, policy.effective_from, policy.effective_until,
            policy.policy_document,
            approval.effective_at AS legal_approval_effective_at,
            approval.review_at AS legal_approval_review_at
     FROM region_policies policy
     LEFT JOIN region_policy_legal_approvals approval
       ON approval.region_policy_id = policy.id
      AND approval.policy_hash = policy.policy_hash
      AND policy.approval_reference = 'region-policy-legal-approval:' || approval.id::TEXT
     WHERE policy.region_code = $1
       AND policy.policy_state = 'ACTIVE'
       AND policy.effective_from <= clock_timestamp()
       AND (policy.effective_until IS NULL OR policy.effective_until > clock_timestamp())
     ORDER BY policy.effective_from DESC, policy.created_at DESC
     LIMIT 1`,
    [regionCode.trim().toUpperCase()],
  );
  return result.rows[0] ?? null;
}
