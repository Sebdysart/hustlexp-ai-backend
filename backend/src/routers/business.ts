/**
 * Business Router v1.0.0 — Roadmap E3 (Business Demand Mode)
 *
 * A single public, rate-limited, compliance-gated intake mutation for the
 * /business demand-sensing lane. Local Eastside businesses register *interest*
 * in recurring task demand; each submission lands in `business_leads` as a
 * NEW lead requiring manual review.
 *
 * SCOPE / HONESTY INVARIANTS (do not violate without a roadmap update):
 *   1. Anonymous intake only — no auth, no account creation, no consumer-funnel
 *      coupling. publicProcedure, like geo.availability.
 *   2. Every lead inserts with status='NEW' and requires_review=true. There is
 *      NO auto-approval path in E3 (review/approval is E4+).
 *   3. PII minimization: only a salted-free SHA-256 ip_hash is stored, never a
 *      raw IP. No email/phone/PII is echoed back to the unauthenticated client.
 *   4. Compliance gate: hard_block submissions are rejected (BAD_REQUEST) and
 *      write no row. soft_flag and clean both insert (always requires_review).
 *   5. Rate-limited via the shared 3-layer pattern (_shared/publicRateLimit)
 *      BEFORE any DB or compliance work.
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { checkPublicAnonRateLimit, deriveIpKey } from './_shared/publicRateLimit.js';

const businessLog = logger.child({ router: 'business' });

// Eastside-only beta ZIPs. Mirrors the allowlist in the web business intake
// form (business-intake-form.tsx) so the page and backend agree on coverage.
// Out-of-area ZIPs are rejected directly — no silent acceptance.
const EASTSIDE_ZIPS = new Set([
  // Redmond
  '98052', '98053', '98073',
  // Sammamish
  '98074', '98075',
  // Bellevue
  '98004', '98005', '98006', '98007', '98008', '98009', '98015',
  // Kirkland
  '98033', '98034',
  // Issaquah
  '98027', '98029',
]);

const BUSINESS_TYPES = [
  'Event venue',
  'Office',
  'Retail shop',
  'Property manager',
  'Moving & storage operator',
  'Small service business',
  'Other',
] as const;

const RECURRING_TASK_TYPES = [
  'Event setup',
  'Moving help',
  'Pickup / dropoff',
  'Errands',
  'Furniture assembly',
  'Cleanup',
  'Inventory runs',
  'Flexible labor support',
] as const;

const FREQUENCY_OPTIONS = [
  'Daily',
  'A few times a week',
  'Weekly',
  'Monthly',
  'Occasionally',
] as const;

const URGENCY_OPTIONS = ['Low', 'Normal', 'High'] as const;

const NOTES_MAX = 1000;

// Anonymous sentinel — compliance evaluate() requires a userId; there is no
// user for an anonymous lead. Its DB side-effects (flagged_phrase_counter
// UPDATE / compliance_violations INSERT) fail gracefully on a non-existent id.
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// E3 success / error copy (zero-promise; verbatim from the roadmap).
const SUCCESS_MESSAGE =
  "Thanks — we received your business registration interest. We'll review it before any access is granted. No account created and nothing charged.";
const COMPLIANCE_BLOCK_MESSAGE =
  'This request cannot be submitted because HustleXP only supports legal, reviewable local task demand.';

const submitLeadInput = z.object({
  businessName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).optional(),
  businessType: z.enum(BUSINESS_TYPES),
  city: z.string().trim().max(120).optional(),
  zip: z
    .string()
    .regex(/^\d{5}$/, 'ZIP must be 5 digits.')
    .refine((z) => EASTSIDE_ZIPS.has(z), {
      message: 'HustleXP is not yet available in this ZIP.',
    }),
  recurringTaskTypes: z.array(z.enum(RECURRING_TASK_TYPES)).min(1).max(RECURRING_TASK_TYPES.length),
  expectedFrequency: z.enum(FREQUENCY_OPTIONS).optional(),
  avgBudgetCents: z.number().int().positive().optional(),
  urgency: z.enum(URGENCY_OPTIONS).optional(),
  notes: z.string().max(NOTES_MAX).optional(),
  riskFlags: z
    .object({
      enteringHomes: z.boolean().optional().default(false),
      handlingKeys: z.boolean().optional().default(false),
      drivingDelivery: z.boolean().optional().default(false),
      regulatedGoods: z.boolean().optional().default(false),
      minorsSchools: z.boolean().optional().default(false),
      cashHandling: z.boolean().optional().default(false),
      customerFacing: z.boolean().optional().default(false),
      sensitiveLocations: z.boolean().optional().default(false),
    })
    .default({}),
  contactPreference: z.enum(['form', 'call']),
});

export const businessRouter = router({
  /**
   * Anonymous business lead intake.
   *
   * EXTERNAL EFFECTS:
   *   - DB writes: INSERT one business_leads row (NEW + requires_review)
   *   - Stripe: no
   *   - Paid LLM: possibly (ComplianceGuardianService may call AI for
   *     ambiguous-score descriptions, same as task posting)
   *   - PII reads: collects business contact info; stores ip_hash only.
   */
  submitLead: publicProcedure
    .input(submitLeadInput)
    .mutation(async ({ input, ctx }) => {
      const ipKey = deriveIpKey(ctx.req?.headers);
      if (!ipKey) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Unable to identify client. Refresh and try again.',
        });
      }

      // Rate limit BEFORE any DB / compliance work.
      await checkPublicAnonRateLimit(ipKey, {
        category: 'business:intake',
        burstLimit: 3,
        burstWindowSec: 60,
        dailyLimit: 20,
        dailyWindowSec: 86400,
        // Conservative global kill switch — this is a low-volume B2B intake.
        globalLimit: 500,
        globalWindowSec: 86400,
        burstMessage: 'Too many attempts. Try again shortly.',
        dailyMessage: 'Too many attempts. Try again shortly.',
        globalMessage: "We couldn't submit this right now. Try again later.",
      });

      // Store only a hash of the IP — never the raw address.
      const ipHash = createHash('sha256').update(ipKey).digest('hex');

      // Compliance gate on notes + the recurring task types. Reuses the same
      // service that screens consumer task descriptions.
      const complianceInput = [input.notes ?? '', input.recurringTaskTypes.join(', ')]
        .filter(Boolean)
        .join('\n');
      const compliance = await ComplianceGuardianService.evaluate({
        description: complianceInput,
        userId: ANONYMOUS_USER_ID,
        ipAddress: ipHash,
      });

      if (compliance.tier === 'hard_block') {
        businessLog.warn(
          { ipHash, score: compliance.score, rules: compliance.triggeredRules },
          'business lead hard-blocked by compliance — no row written'
        );
        throw new TRPCError({ code: 'BAD_REQUEST', message: COMPLIANCE_BLOCK_MESSAGE });
      }

      // E3: every lead is manually reviewed. No auto-approval — status is
      // hardcoded NEW and requires_review is always true regardless of tier or
      // risk flags.
      const requiresReview = true;

      await db.query(
        `INSERT INTO business_leads (
           business_name, contact_name, email, phone, business_type, city, zip,
           recurring_task_types, expected_frequency, avg_budget_cents, urgency, notes,
           risk_flags, contact_preference, status, compliance_score, compliance_notes,
           requires_review, source, ip_hash
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9, $10, $11, $12,
           $13::jsonb, $14, 'NEW', $15, $16::jsonb,
           $17, 'web', $18
         )`,
        [
          input.businessName,
          input.contactName,
          input.email,
          input.phone ?? null,
          input.businessType,
          input.city ?? null,
          input.zip,
          JSON.stringify(input.recurringTaskTypes),
          input.expectedFrequency ?? null,
          input.avgBudgetCents ?? null,
          input.urgency ?? null,
          input.notes ?? null,
          JSON.stringify(input.riskFlags),
          input.contactPreference,
          compliance.score,
          JSON.stringify(compliance.notes),
          requiresReview,
          ipHash,
        ]
      );

      businessLog.info(
        { ipHash, tier: compliance.tier, score: compliance.score },
        'business lead captured (NEW, requires_review)'
      );

      // Safe output only — no id, no PII echoed back to the anonymous client.
      return {
        status: 'NEW' as const,
        requiresReview,
        message: SUCCESS_MESSAGE,
      };
    }),
});
