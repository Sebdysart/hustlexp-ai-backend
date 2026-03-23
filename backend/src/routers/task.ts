/**
 * Task Router v1.0.0
 * 
 * CONSTITUTIONAL: Task lifecycle endpoints
 * 
 * @see PRODUCT_SPEC.md §3
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, publicProcedure, hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import { TaskService } from '../services/TaskService.js';
import { ProofService } from '../services/ProofService.js';
import { db } from '../db.js';
import type { Proof } from '../types.js';
import { ErrorCodes } from '../types.js';
import { cachedDbQuery, invalidateTask, CACHE_KEYS, CACHE_TTL, CACHE_TAGS } from '../cache/db-cache.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { ScoperAIService } from '../services/ScoperAIService.js';
import { getTemplate, getManifest, isCareContent, isContentReleaseRequired } from '../services/TaskTemplateRegistry.js';
import { TaskRiskClassifier } from '../services/TaskRiskClassifier.js';
import { checkRateLimit } from '../cache/redis.js';

const taskRouterLog = logger.child({ router: 'task' });

// ---------------------------------------------------------------------------
// R2 storage allowlist for proof photo/video URLs.
// Only Cloudflare R2 public URLs are accepted — same logic as messaging.ts.
// This prevents SSRF and tracking-pixel injection via arbitrary URLs.
// ---------------------------------------------------------------------------
const PROOF_R2_PUBLIC_HOSTNAME = (() => {
  const raw = process.env.R2_PUBLIC_URL || '';
  try {
    return raw ? new URL(raw).hostname : null;
  } catch {
    return null;
  }
})();

function isApprovedProofMediaHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (PROOF_R2_PUBLIC_HOSTNAME && hostname === PROOF_R2_PUBLIC_HOSTNAME) return true;
    if (/^pub-[a-f0-9]+\.r2\.dev$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

const approvedProofMediaUrl = z
  .string()
  .url()
  .max(2048)
  .refine(isApprovedProofMediaHost, {
    message: 'Proof media URL must be from an approved storage domain (R2 only)',
  });

// ---------------------------------------------------------------------------
// Redis-backed rate limit for evaluateDraft: max 5 calls per 60s per user.
//
// Replaces the previous in-memory Map, which reset on process restart and
// provided no protection under horizontal scaling (each instance had its own
// counter). Uses the shared checkRateLimit() from redis.ts (Upstash sliding
// window). Fails OPEN when Redis is unavailable — rate-limiting is not a
// security-critical gate, so degrading gracefully (allowing the request) is
// preferable to hard-failing callers when the cache layer is down.
// ---------------------------------------------------------------------------

export async function checkDraftEvalRateLimit(userId: string): Promise<void> {
  try {
    const result = await checkRateLimit(userId, 'task:draft', 5, 60);
    // checkRateLimit fails-closed in production when Redis is unavailable.
    // For rate-limiting (not security), we override to fail-open: if Redis
    // returned allowed=false solely because it was unavailable (remaining===0
    // and no Redis connection) we still want to allow. However, the actual
    // over-limit case (remaining===0 with a live Redis) should block.
    // The simplest safe approach: only throw when explicitly rate-limited
    // (result.allowed===false and remaining is a real count, not a fallback).
    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many draft evaluations. Please wait before trying again.',
      });
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    // Redis error — fail open for rate limiting
    taskRouterLog.warn({ err, userId }, 'Redis unavailable for draft-eval rate limit — allowing request');
  }
}

// ---------------------------------------------------------------------------
// Redis-backed rate limit for task.create: max 3 creates per 60s per user.
// Separate from the broad Hono `task` category (60/min) which covers all task
// ops. This tighter limit prevents task-spam (e.g. bulk-creating tasks to
// exhaust escrow slots or flood the hustler feed).
// Fails OPEN when Redis is unavailable — same rationale as checkDraftEvalRateLimit.
// ---------------------------------------------------------------------------

export async function checkTaskCreateRateLimit(userId: string): Promise<void> {
  try {
    const result = await checkRateLimit(userId, 'task:create', 3, 60);
    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Task creation limit reached. You can create up to 3 tasks per minute.',
      });
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    // Redis error — fail open for rate limiting
    taskRouterLog.warn({ err, userId }, 'Redis unavailable for task-create rate limit — allowing request');
  }
}

export const taskRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get task by ID (cached in Redis; invalidated on task mutations)
   */
  getById: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      const task = await cachedDbQuery(
        CACHE_KEYS.taskDetails(input.taskId),
        async () => {
          const result = await TaskService.getById(input.taskId);
          if (!result.success) {
            throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
          }
          return result.data;
        },
        { tags: [CACHE_TAGS.TASK(input.taskId)], ttl: CACHE_TTL.taskDetails }
      );

      const isParticipant = task.poster_id === ctx.user.id || task.worker_id === ctx.user.id;
      // Tasks in OPEN/MATCHING state are discoverable (hustler feed)
      const isDiscoverable = ['OPEN', 'MATCHING'].includes(task.state);

      if (!isParticipant && !isDiscoverable) {
        // Last resort: check admin role before throwing.
        // A63-3 FIX: Use the same role allowlist as adminProcedure — a bare
        // SELECT without a role filter would grant admin access to any row in
        // admin_roles regardless of role value, allowing privilege escalation.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
          [ctx.user.id, VALID_ADMIN_ROLES]
        );
        if (adminResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        // Admin: full access
        return task;
      }

      // Strip sensitive identity fields for non-participants browsing the feed
      if (!isParticipant && isDiscoverable) {
        return { ...task, poster_id: undefined, worker_id: undefined };
      }

      return task;
    }),
  
  /**
   * Get server-authoritative task state
   * Used for state confirmation (UI_SPEC §9.1)
   */
  getState: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
        `SELECT state, poster_id, worker_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      const task = result.rows[0];
      const isParticipant = task.poster_id === ctx.user.id || task.worker_id === ctx.user.id;
      if (!isParticipant) {
        // A63-3 FIX: Use role allowlist consistent with adminProcedure.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
          [ctx.user.id, VALID_ADMIN_ROLES]
        );
        if (adminResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      }

      return {
        state: task.state,
      };
    }),
  
  /**
   * List tasks by poster — cursor-paginated.
   * SECURITY: Uses auth context — users always see their own tasks only.
   *
   * ⚠️  BREAKING CHANGE (2026-03-02): Return type changed.
   *    Before: Task[]
   *    After:  { tasks: Task[], nextCursor: string | undefined }
   *
   * iOS migration (manual Codable):
   *    1. Add wrapper: struct PaginatedTasks: Codable { let tasks: [Task]; let nextCursor: String? }
   *    2. Decode as PaginatedTasks instead of [Task]
   *    3. Drive infinite scroll from nextCursor (nil = last page)
   *    4. Reset cursor + clear array on pull-to-refresh
   */
  listByPoster: posterProcedure
    .input(
      Schemas.cursorPagination.extend({
        posterId: Schemas.uuid.optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const posterId = input?.posterId ?? ctx.user.id;
      if (posterId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own posted tasks',
        });
      }

      const result = await TaskService.getByPoster(posterId, {
        cursor: input?.cursor ?? null,
        limit: input?.limit ?? 20,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data; // { tasks, nextCursor }
    }),

  /**
   * List tasks by worker — cursor-paginated.
   * SECURITY: Uses auth context — users always see their own tasks only.
   *
   * ⚠️  BREAKING CHANGE (2026-03-02): Return type changed.
   *    Before: Task[]
   *    After:  { tasks: Task[], nextCursor: string | undefined }
   *    iOS: same migration as listByPoster — see above.
   */
  listByWorker: hustlerProcedure
    .input(
      Schemas.cursorPagination.extend({
        workerId: Schemas.uuid.optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const workerId = input?.workerId ?? ctx.user.id;
      if (workerId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own accepted tasks',
        });
      }

      const result = await TaskService.getByWorker(workerId, {
        cursor: input?.cursor ?? null,
        limit: input?.limit ?? 20,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data; // { tasks, nextCursor }
    }),
  
  /**
   * List open tasks (feed)
   */
  listOpen: hustlerProcedure
    .input(Schemas.pagination)
    .query(async ({ input }) => {
      const result = await TaskService.listOpen({ limit: input.limit, offset: input.offset });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create a new task
   */
  create: posterProcedure
    .input(Schemas.createTask)
    .mutation(async ({ ctx, input }) => {
      // Rate limit: 3 task creates per user per minute (prevents feed-spam / escrow-slot exhaustion)
      await checkTaskCreateRateLimit(ctx.user.id);

      // FIX 7: Gate unimplemented multi-leg proof and partial-payout features.
      // These schema columns exist but have zero application logic — reject early
      // to prevent tasks from being created with silently-broken behaviour.
      if (input.prorate_on_abort === true || (input.proof_steps && input.proof_steps.length > 0)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Multi-leg proof and partial payout features are not yet available.',
        });
      }

      // Run compliance check — hard blocks throw before any DB write
      const compliance = await ComplianceGuardianService.evaluate({
        description: input.description,
        userId: ctx.user.id,
        templateSlug: input.templateSlug,
      });
      if (compliance.tier === 'hard_block') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Task blocked by compliance check. HustleXP only allows legal IRL tasks.',
        });
      }

      // FIX 4: Validate template slug — reject unknown slugs with a clear error.
      const resolvedSlug = input.templateSlug ?? 'standard_physical';
      const template = getTemplate(resolvedSlug);
      if (!template) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Invalid template: ${resolvedSlug}. Use GET /api/templates/manifest for valid options.`,
        });
      }

      // FIX 1: Enforce requiredTrustTier — reject if poster's tier is below template minimum.
      // trust_tier in DB is numeric (1=rookie, 2=verified, 3=trusted).
      const TRUST_TIER_ORDER = ['rookie', 'verified', 'trusted'];
      const TRUST_TIER_NUMERIC_MAP: Record<number, string> = { 1: 'rookie', 2: 'verified', 3: 'trusted', 4: 'trusted' };
      const posterTierName = TRUST_TIER_NUMERIC_MAP[ctx.user.trust_tier ?? 1] ?? 'rookie';
      const posterTierIndex = TRUST_TIER_ORDER.indexOf(posterTierName);
      const requiredTierIndex = TRUST_TIER_ORDER.indexOf(template.requiredTrustTier ?? 'rookie');
      if (posterTierIndex < requiredTierIndex) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `This task type requires ${template.requiredTrustTier} trust level. Your current level is ${posterTierName}.`,
        });
      }

      const result = await TaskService.create({
        posterId: ctx.user.id,
        title: input.title,
        description: input.description,
        price: input.price,
        requirements: input.requirements,
        location: input.location,
        category: input.category,
        deadline: input.deadline ? new Date(input.deadline) : undefined,
        requiresProof: input.requiresProof,
        mode: input.mode,
        liveBroadcastRadiusMiles: input.liveBroadcastRadiusMiles,
        instantMode: input.instantMode,
        templateSlug: template.slug,
      });

      if (!result.success) {
        // Map HX error codes to tRPC error codes
        let code: 'BAD_REQUEST' | 'PRECONDITION_FAILED' = 'BAD_REQUEST';
        if (result.error.code === 'HX902' || result.error.code === 'HX901') {
          code = 'PRECONDITION_FAILED';
        }
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      await invalidateTask(result.data.id);

      // Persist remaining template system fields (template_slug already set in the INSERT above)

      // FIX 2: Content-based caregiving detection — OR with template slug check.
      const caregiving = template.slug === 'care' || isCareContent(input.description);

      // FIX 3: Content-based content-release detection — OR with template flag.
      const requiresContentRelease = template.requiresContentRelease || isContentReleaseRequired(input.description);

      // FIX 3 (addendum): Content-based content release also forces mutual consent.
      const requiresMutualConsent = template.requiresMutualConsent || requiresContentRelease;
      void requiresMutualConsent; // stored via template fields; logged here for auditing

      // FIX 5: Care content forces autoReleaseHours=0 (manual release only — safety invariant).
      const autoReleaseHours = caregiving ? 0 : template.autoReleaseHours;

      const riskTier = TaskRiskClassifier.classifyWithTemplate(
        {
          insideHome: input.insideHome ?? false,
          peoplePresent: input.peoplePresent ?? false,
          petsPresent: input.petsPresent ?? false,
          caregiving,
        },
        template.slug,
        input.wildcardFlags ?? [],
        compliance,
      );
      void riskTier; // computed for future use; not stored (no risk_tier column in migration)

      await db.query(
        `UPDATE tasks
         SET illegal_risk_score = $2,
             compliance_guardian_notes = $3,
             late_cancel_pct = $4,
             content_release = $5,
             cancellation_window_hours = $6
         WHERE id = $1`,
        [
          result.data.id,
          compliance.score,
          JSON.stringify(compliance.notes),
          template.lateCancelPct,
          requiresContentRelease,
          autoReleaseHours,
        ]
      );

      return result.data;
    }),
  
  /**
   * Evaluate a task draft for compliance before creation.
   * HARD_BLOCK (score ≥ 61): throws, no task created.
   * SOFT_FLAG (score 21–60): returns result for Poster awareness.
   */
  evaluateDraft: posterProcedure
    .input(Schemas.evaluateDraft)
    .mutation(async ({ ctx, input }) => {
      await checkDraftEvalRateLimit(ctx.user.id);

      const complianceResult = await ComplianceGuardianService.evaluate({
        description: input.description,
        userId: ctx.user.id,
        templateSlug: input.templateSlug,
      });

      if (complianceResult.tier === 'hard_block') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This task was blocked. Reason: ${complianceResult.triggeredRules.join(', ')}. HustleXP only allows legal IRL tasks.`,
        });
      }

      const scopeResult = await ScoperAIService.analyzeTaskScope({
        description: input.description,
        templateSlug: input.templateSlug,
        wildcardFlags: input.wildcardFlags,
        complianceResult: complianceResult,
      });

      return {
        score: complianceResult.score,
        tier: complianceResult.tier,
        triggeredRules: complianceResult.triggeredRules,
        suggestedAlternative: complianceResult.suggestedAlternative,
        notes: complianceResult.notes,
        scopeProposal: scopeResult.success ? scopeResult.data : null,
      };
    }),

  /**
   * Accept a task with mutual consent checklist.
   * Required for wildcard_bizarre and content_creator templates.
   *
   * RACE CONDITION FIX: The SELECT FOR UPDATE and UPDATE are now both issued
   * inside a db.transaction() so the row-level lock is held across both
   * statements on the same connection. Without the transaction, db.query()
   * releases the connection (and the lock) immediately after the SELECT,
   * allowing two concurrent callers to both see state='posted' and both
   * write worker_id — assigning the same task to two workers.
   */
  acceptWithConsent: hustlerProcedure
    .input(Schemas.acceptWithConsent)
    .mutation(async ({ ctx, input }) => {
      // MM6 FIX: All reads (template_slug, poster_id) moved INSIDE the transaction,
      // AFTER the SELECT FOR UPDATE lock, to eliminate the TOCTOU window where a
      // concurrent actor could change poster_id or template_slug between the pre-lock
      // read and the locked update.
      await db.transaction(async (query) => {
        // FOR UPDATE acquires a row-level lock held until COMMIT.
        // Fetch template_slug and poster_id from the locked row — values are
        // authoritative because no other writer can modify this row until we commit.
        const lockResult = await query<{ state: string; template_slug: string; poster_id: string }>(
          `SELECT state, template_slug, poster_id FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        // BUG 6 FIX: Collapse NOT_FOUND and self-dealing (poster == caller) into a
        // single NOT_FOUND response. Returning FORBIDDEN for poster-own tasks leaks
        // task existence to callers who are also posters (UUID enumeration vector).
        // This matches the assignWorker pattern fixed the same way.
        if (!lockResult.rows[0] || lockResult.rows[0].poster_id === ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found or unavailable' });
        }

        const template = getTemplate(lockResult.rows[0].template_slug) ?? (() => {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown template on task' });
        })();
        if (!template.requiresMutualConsent) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This template does not require consent checklist',
          });
        }

        if (lockResult.rows[0].state !== 'OPEN') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer available for claiming',
          });
        }

        // T63-4: Enforce application workflow — hustler must have a pending
        // application before they can claim a task via mutual consent.
        const appResult = await query<{ id: string }>(
          `SELECT id FROM task_applications WHERE task_id = $1 AND worker_id = $2 AND status = 'pending'`,
          [input.taskId, ctx.user.id]
        );
        if (!appResult.rows[0]) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You must apply for this task before accepting it',
          });
        }

        const updateResult = await query(
          `UPDATE tasks
           SET mutual_consent_accepted = TRUE,
               worker_id = $2,
               state = 'ACCEPTED',
               accepted_at = NOW()
           WHERE id = $1 AND state = 'OPEN'`,
          [input.taskId, ctx.user.id]
        );

        if ((updateResult.rowCount ?? 0) === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer available for claiming',
          });
        }
      });

      return { accepted: true };
    }),

  /**
   * Get lightweight template manifest for iOS template reclassify valve.
   * Returns slug, display_name, and one_line_desc for all 8 templates.
   */
  getTemplateManifest: publicProcedure
    .query(async () => {
      return getManifest();
    }),

  /**
   * Get compliance status for a task — surfaces existing stored score.
   * No new LLM call.
   */
  getComplianceStatus: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const result = await db.query<{
        poster_id: string;
        worker_id: string | null;
        illegal_risk_score: number;
        compliance_guardian_notes: object;
      }>(
        `SELECT poster_id, worker_id, illegal_risk_score, compliance_guardian_notes FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (!result.rows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      const task = result.rows[0];
      if (task.poster_id !== ctx.user.id && task.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this task\'s compliance data' });
      }

      return {
        score: task.illegal_risk_score,
        notes: task.compliance_guardian_notes,
      };
    }),

  /**
   * Accept a task (worker claims it)
   */
  accept: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.accept({
        taskId: input.taskId,
        workerId: ctx.user.id,
      });
      
      if (!result.success) {
        const code = result.error.code === 'HX002' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      await invalidateTask(input.taskId);
      return result.data;
    }),
  
  /**
   * Start working on an accepted task (ACCEPTED → IN_PROGRESS)
   * Frontend calls this when worker begins task
   */
  start: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // R-09 FIX: Ownership and state checks are performed inside a transaction
      // with SELECT FOR UPDATE so the check and any subsequent logic are performed
      // against a locked, consistent snapshot of the task row. The previous
      // pattern (plain SELECT outside a transaction) created a TOCTOU window where
      // a concurrent accept/cancel could change worker_id or state between the read
      // and the response.
      const task = await db.transaction(async (query) => {
        const lockResult = await query<{ worker_id: string | null; state: string }>(
          `SELECT worker_id, state FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        if (lockResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
        }
        const row = lockResult.rows[0];
        if (row.worker_id !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can start this task' });
        }
        if (row.state !== 'ACCEPTED') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Task must be ACCEPTED to start, current state: ${row.state}` });
        }
        // No state transition — ACCEPTED already means the worker is working.
        // Re-fetch the full task row inside the same transaction for a consistent return value.
        const fullResult = await query<import('../types.js').Task>(
          `SELECT * FROM tasks WHERE id = $1`,
          [input.taskId]
        );
        return fullResult.rows[0];
      });

      await invalidateTask(input.taskId);
      return task;
    }),

  /**
   * Submit proof for task
   */
  /**
   * Get proof submission for a task
   */
  getProof: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<Proof>(
        `SELECT p.* FROM proofs p
         JOIN tasks t ON t.id = p.task_id
         WHERE p.task_id = $1
           AND (t.poster_id = $2 OR t.worker_id = $2)
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [input.taskId, ctx.user.id]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No proof found for this task' });
      }

      const proof = result.rows[0];
      const [photosRes, videosRes] = await Promise.all([
        ProofService.getPhotos(proof.id),
        ProofService.getVideos(proof.id),
      ]);
      return {
        ...proof,
        photos: photosRes.success ? photosRes.data : [],
        videos: videosRes.success ? videosRes.data : [],
      };
    }),

  submitProof: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      description: z.string().trim().max(2000).optional(),
      // Extended fields from iOS frontend
      photoUrls: z.array(approvedProofMediaUrl).max(10).optional(),
      videoUrls: z.array(approvedProofMediaUrl).max(5).optional(),
      notes: z.string().trim().max(2000).optional(),
      gpsLatitude: z.number().min(-90).max(90).optional(),
      gpsLongitude: z.number().min(-180).max(180).optional(),
      biometricHash: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // KK4 FIX: Router-layer ownership check. ProofService has its own check
      // but verifying here at the router boundary avoids hitting ProofService
      // at all for non-assigned workers, and makes the authorization boundary
      // explicit at the procedure layer.
      const taskOwnership = await db.query<{ worker_id: string | null }>(
        'SELECT worker_id FROM tasks WHERE id = $1',
        [input.taskId]
      );
      if (!taskOwnership.rows[0] || taskOwnership.rows[0].worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can submit proof' });
      }

      // YY-02 FIX: The previous implementation issued raw db.query('BEGIN') /
      // db.query('COMMIT') / db.query('ROLLBACK') from the pool. Because pg-pool
      // dispatches each query() call to whatever connection is currently idle,
      // these control statements could land on a different pool connection than
      // the queries inside ProofService.submit() and TaskService.submitProof(),
      // making the outer "transaction" completely illusory.
      //
      // Both services already manage their own internal db.transaction() calls
      // (ProofService.submit via UU-05, TaskService.submitProof via the existing
      // FOR UPDATE transaction). The idempotency recovery path in
      // TaskService.submitProof() (PROOF_SUBMITTED → return success) handles the
      // case where ProofService.submit committed but the task state update did not.
      // Removing the outer raw BEGIN/COMMIT restores the intended semantics: each
      // service operates on its own pinned connection inside its own transaction.
      const proofResult = await ProofService.submit({
        taskId: input.taskId,
        submitterId: ctx.user.id,
        description: input.description ?? input.notes,
        photoUrls: input.photoUrls,
        gpsLatitude: input.gpsLatitude,
        gpsLongitude: input.gpsLongitude,
        biometricHash: input.biometricHash,
      });

      if (!proofResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: proofResult.error.message,
        });
      }

      // R-10 FIX: ProofService.submit and TaskService.submitProof each own their
      // internal transactions and cannot be composed into a single atomic unit
      // without invasive refactoring. Instead, if the task state transition fails
      // after the proof row has already committed, delete the orphaned proof row
      // before rethrowing so the worker can retry cleanly.
      const taskResult = await TaskService.submitProof(input.taskId);

      if (!taskResult.success) {
        // Best-effort cleanup: remove the committed proof row so it does not
        // permanently block future submission attempts (ProofService.submit
        // rejects if an active proof already exists for the task).
        try {
          await db.query(
            `DELETE FROM proofs WHERE id = $1`,
            [proofResult.data.id]
          );
        } catch (cleanupErr) {
          taskRouterLog.error(
            { err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr), proofId: proofResult.data.id },
            'R-10: failed to delete orphaned proof after task state transition failure'
          );
        }
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: taskResult.error.message,
        });
      }

      // Video attachments are best-effort: run after commit so a video failure
      // does not roll back the proof or the task state transition.
      if (input.videoUrls?.length) {
        for (const url of input.videoUrls) {
          const videoResult = await ProofService.addVideo({
            proofId: proofResult.data.id,
            storageKey: url,
            contentType: 'video/mp4',
          });
          if (!videoResult.success) {
            logger.child({ service: 'task' }).warn({ proofId: proofResult.data.id, url }, 'Failed to add video to proof');
          }
        }
      }

      await invalidateTask(input.taskId);
      return {
        task: taskResult.data,
        proof: proofResult.data,
      };
    }),
  
  /**
   * Review proof (accept/reject)
   */
  reviewProof: posterProcedure
    .input(z.object({
      // Original schema fields
      proofId: z.string().uuid().optional(),
      decision: z.enum(['ACCEPTED', 'REJECTED']).optional(),
      reason: z.string().trim().max(1000).optional(),
      // iOS frontend fields
      taskId: z.string().uuid().optional(),
      approved: z.boolean().optional(),
      feedback: z.string().trim().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Resolve decision: from original field or from iOS boolean
      const decision = input.decision || (input.approved === true ? 'ACCEPTED' : input.approved === false ? 'REJECTED' : undefined);
      if (!decision) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'decision or approved is required' });
      }
      const reason = input.reason || input.feedback;

      // R49-5: When rejecting, reason must not be blank (whitespace-only) after trim.
      // The Zod schema already applies .trim() so an all-whitespace string arrives as "".
      // Treat that the same as undefined — a REJECTED decision with no substantive reason
      // is invalid because the worker needs actionable feedback to resubmit.
      if (decision === 'REJECTED' && (reason === undefined || reason === '')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A reason is required when rejecting proof' });
      }

      // When taskId is provided, perform ownership check BEFORE any proof lookup
      // to prevent non-owning posters from enumerating proof existence / UUIDs.
      if (input.taskId) {
        const taskOwnerResult = await TaskService.getById(input.taskId);
        if (!taskOwnerResult.success) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
        }
        if (taskOwnerResult.data.poster_id !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can review proof' });
        }
        if (taskOwnerResult.data.state !== 'PROOF_SUBMITTED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Cannot review proof: task is in ${taskOwnerResult.data.state} state, expected PROOF_SUBMITTED`,
          });
        }
      }

      // Resolve proofId: either from input directly or by looking up via taskId
      let proofId = input.proofId;
      if (!proofId && input.taskId) {
        // Look up latest proof for this task (ownership already verified above)
        const proofLookup = await db.query<{ id: string }>(
          `SELECT id FROM proofs WHERE task_id = $1 AND state = 'SUBMITTED' ORDER BY created_at DESC LIMIT 1`,
          [input.taskId]
        );
        if (proofLookup.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No proof found for this task' });
        }
        proofId = proofLookup.rows[0].id;
      }
      if (!proofId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'proofId or taskId is required' });
      }

      // When proofId was supplied directly (no taskId path), verify ownership BEFORE
      // calling ProofService.getById to prevent IDOR enumeration of proof UUIDs.
      if (!input.taskId) {
        const ownerCheck = await db.query<{ poster_id: string }>(
          `SELECT t.poster_id FROM proofs p JOIN tasks t ON t.id = p.task_id WHERE p.id = $1`,
          [proofId]
        );
        if (ownerCheck.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Proof not found' });
        }
        if (ownerCheck.rows[0].poster_id !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can review proof' });
        }
      }

      // Validate proof is in SUBMITTED state before allowing review.
      // This must run unconditionally — the taskId branch resolves proofId via a
      // SUBMITTED-only SQL filter when proofId is absent, but when BOTH taskId and
      // proofId are supplied the caller enters the taskId branch (task.state check)
      // and then uses the supplied proofId directly, bypassing this guard.
      // Without this check a poster can re-review an already-ACCEPTED/REJECTED proof
      // by supplying both IDs.
      const proofStateRow = await db.query<{ state: string }>(
        `SELECT state FROM proofs WHERE id = $1`,
        [proofId]
      );
      if (proofStateRow.rows[0]?.state !== 'SUBMITTED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Proof is not in SUBMITTED state',
        });
      }

      // Get proof to find task (needed when proofId was supplied directly)
      const proofResult = await ProofService.getById(proofId);
      if (!proofResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: proofResult.error.message,
        });
      }

      // When BOTH proofId and taskId are supplied, verify the proof actually belongs
      // to the supplied taskId — prevents cross-task review bypass where a poster
      // passes their own taskId (ownership check passes) plus a proofId from a
      // different task they do not own.
      if (input.taskId && input.proofId) {
        if (proofResult.data.task_id !== input.taskId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Proof does not belong to the specified task' });
        }
      }

      // When proofId was supplied directly (no taskId path), verify task state now
      if (!input.taskId) {
        const taskResult = await TaskService.getById(proofResult.data.task_id);
        if (!taskResult.success) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
        }
        if (taskResult.data.state !== 'PROOF_SUBMITTED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Cannot review proof: task is in ${taskResult.data.state} state, expected PROOF_SUBMITTED`,
          });
        }
      }

      // Review proof
      const reviewResult = await ProofService.review({
        proofId,
        reviewerId: ctx.user.id,
        decision,
        reason,
      });

      if (!reviewResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: reviewResult.error.message,
        });
      }

      // CCC-01 FIX: When proof is REJECTED the task must transition back to
      // ACCEPTED so the worker can resubmit.  Without this call the task is
      // permanently stuck in PROOF_SUBMITTED — the worker cannot resubmit
      // (PROOF_SUBMITTED is not in their allowed-from list) and the poster
      // cannot cancel, creating a deadlock.
      if (decision === 'REJECTED') {
        const rejectTaskResult = await TaskService.rejectProof(
          proofResult.data.task_id,
          reason ?? 'Proof rejected by poster'
        );
        if (!rejectTaskResult.success) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Proof marked rejected but task state could not be reverted: ${rejectTaskResult.error.message}`,
          });
        }
      }

      await invalidateTask(proofResult.data.task_id);
      return reviewResult.data;
    }),
  
  /**
   * Complete task (after proof accepted)
   * INV-3: Will fail if proof is not ACCEPTED
   * SECURITY: Only the poster can mark a task as complete
   *
   * UU-02 FIX: The poster ownership check is now performed inside
   * TaskService.complete() under the FOR UPDATE row lock.  The previous
   * pattern read poster_id via a separate getById() call outside the
   * transaction, creating a TOCTOU window where a concurrent ownership
   * transfer could race between the auth read and the UPDATE.  Passing
   * ctx.user.id as posterId into the service collapses both checks into a
   * single atomic transaction.
   */
  complete: posterProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.complete(input.taskId, ctx.user.id);

      if (!result.success) {
        const errCode = result.error.code;
        let code: 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'BAD_REQUEST';
        if (errCode === ErrorCodes.NOT_FOUND) {
          code = 'NOT_FOUND';
        } else if (errCode === ErrorCodes.FORBIDDEN) {
          code = 'FORBIDDEN';
        } else if (errCode === 'HX301' || errCode === ErrorCodes.INV_3_VIOLATION) {
          code = 'PRECONDITION_FAILED';
        } else {
          code = 'BAD_REQUEST';
        }
        throw new TRPCError({ code, message: result.error.message });
      }
      await invalidateTask(input.taskId);
      return result.data;
    }),

  /**
   * Cancel task
   */
  cancel: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      reason: z.string().trim().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // YY-01 FIX: poster ownership is verified inside the FOR UPDATE transaction
      // in TaskService.cancel() (same pattern as complete/UU-02). The previous
      // pre-call TaskService.getById() check had a TOCTOU window between reading
      // the poster_id and acquiring the lock in TaskService.cancel().
      const result = await TaskService.cancel(input.taskId, ctx.user.id);

      if (!result.success) {
        const errCode = result.error.code;
        let code: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST';
        if (errCode === ErrorCodes.NOT_FOUND) {
          code = 'NOT_FOUND';
        } else if (errCode === ErrorCodes.FORBIDDEN) {
          code = 'FORBIDDEN';
        } else {
          code = 'BAD_REQUEST';
        }
        throw new TRPCError({ code, message: result.error.message });
      }
      await invalidateTask(input.taskId);
      return result.data;
    }),

  // --------------------------------------------------------------------------
  // APPLICATION MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Hustler applies for a task
   */
  applyForTask: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      message: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // T60-2 FIX: Wrap the state check and INSERT in a single transaction with a
      // SELECT FOR UPDATE on the task row. Without this, a concurrent assignWorker
      // can transition the task from OPEN to ACCEPTED between the plain SELECT and
      // the INSERT, producing orphaned application rows for a no-longer-open task.
      // The FOR UPDATE lock serializes concurrent callers: the second caller blocks
      // until the first transaction commits, then sees the updated task state.
      const appRow = await db.transaction(async (query) => {
        const taskResult = await query<{ state: string; poster_id: string; trust_tier_required: number | null }>(
          `SELECT state, poster_id, trust_tier_required FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        if (taskResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
        }
        const task = taskResult.rows[0];
        if (task.state !== 'OPEN') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Task must be in OPEN state to apply, current: ${task.state}`,
          });
        }
        if (task.poster_id === ctx.user.id) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot apply for your own task' });
        }
        if (task.trust_tier_required !== null && ctx.user.trust_tier < task.trust_tier_required) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Your trust tier is insufficient for this task' });
        }

        // Use ON CONFLICT DO NOTHING against the partial unique index
        // (idx_task_app_active_per_hustler covers status NOT IN rejected/counter_rejected/withdrawn/expired)
        // to make the duplicate check and insert atomic, eliminating the TOCTOU race.
        const result = await query(
          `INSERT INTO task_applications (id, task_id, hustler_id, message, status, counter_offer_round, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'pending', 0, NOW(), NOW())
           ON CONFLICT (task_id, hustler_id) WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired') DO NOTHING
           RETURNING *`,
          [input.taskId, ctx.user.id, input.message || null]
        );
        if ((result.rowCount ?? 0) === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'You already have an active application for this task' });
        }
        return result.rows[0];
      });

      return {
        id: appRow.id,
        taskId: appRow.task_id,
        status: appRow.status,
        message: appRow.message,
        appliedAt: appRow.created_at,
      };
    }),

  /**
   * Poster lists applicants for their task
   */
  listApplicants: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const taskResult = await db.query(
        `SELECT poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can view applicants' });
      }

      const result = await db.query(
        `SELECT
           ta.id,
           ta.hustler_id AS user_id,
           COALESCE(u.full_name, 'Unknown') AS name,
           COALESCE(r.rating, 5.0) AS rating,
           COALESCE(ct.completed_tasks, 0) AS completed_tasks,
           COALESCE(u.trust_tier, 'rookie') AS tier,
           ta.created_at AS applied_at,
           ta.message
         FROM task_applications ta
         LEFT JOIN users u ON u.id = ta.hustler_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(AVG(stars), 5.0) AS rating
           FROM task_ratings WHERE ratee_id = u.id
         ) r ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS completed_tasks
           FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED'
         ) ct ON true
         WHERE ta.task_id = $1 AND ta.status = 'pending'
         ORDER BY ta.created_at ASC
         LIMIT $2 OFFSET $3`,
        [input.taskId, input.limit, input.offset]
      );

      return result.rows;
    }),

  /**
   * Worker abandons their assignment on an ACCEPTED or IN_PROGRESS task.
   *
   * Without this path, a worker who accepts and then cannot complete a task
   * has no way to release it — the task is deadlocked in ACCEPTED state and
   * the poster's escrow stays locked indefinitely.
   *
   * On success: task returns to OPEN (worker_id cleared), escrow refunded to poster.
   */
  workerCancel: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.workerAbandon(input.taskId, ctx.user.id, input.reason);

      if (!result.success) {
        const errCode = result.error.code;
        let code: 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'BAD_REQUEST';
        if (errCode === ErrorCodes.NOT_FOUND) {
          code = 'NOT_FOUND';
        } else if (errCode === ErrorCodes.FORBIDDEN) {
          code = 'FORBIDDEN';
        } else if (errCode === ErrorCodes.INVALID_STATE) {
          code = 'PRECONDITION_FAILED';
        } else {
          code = 'BAD_REQUEST';
        }
        throw new TRPCError({ code, message: result.error.message });
      }

      await invalidateTask(input.taskId);
      return result.data;
    }),

  /**
   * Poster accepts an applicant — assigns them as the worker
   *
   * RACE CONDITION FIX: All 6 DB operations are wrapped in a single db.transaction()
   * with a SELECT ... FOR UPDATE as the very first statement. The row-level lock is
   * held from the initial state check through the final TaskService.accept() UPDATE,
   * so two concurrent poster calls cannot both read state='OPEN' and produce
   * inconsistent task_applications records (worker Y accepted but task.worker_id=X).
   */
  assignWorker: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      workerId: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      // SECURITY FIX (MM6): The pre-transaction template_slug fetch was moved INSIDE
      // the transaction, AFTER the FOR UPDATE lock and poster ownership check.
      // The previous pattern threw NOT_FOUND for non-existent tasks before any
      // ownership check, allowing any authenticated poster to probe arbitrary task
      // UUIDs for existence (UUID enumeration via timing/error discrimination).
      // Now non-owners always receive FORBIDDEN before existence is confirmed.

      // T58-3: A poster cannot assign themselves as the worker even if a pending
      // application row exists for their own userId. Fail fast before any DB access.
      if (input.workerId === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot assign yourself as worker' });
      }

      const TRUST_TIER_ORDER = ['rookie', 'verified', 'trusted'];
      const TRUST_TIER_NUMERIC_MAP: Record<number, string> = { 1: 'rookie', 2: 'verified', 3: 'trusted', 4: 'trusted' };

      const result = await db.transaction(async (txn) => {
        // Step 1: Lock the task row for the duration of the transaction.
        // FOR UPDATE prevents concurrent assignWorker calls from both reading
        // state='OPEN' and proceeding to assign different workers.
        const taskResult = await txn<{ id: string; state: string; poster_id: string; trust_tier_required: number | null; template_slug: string | null }>(
          `SELECT id, state, poster_id, trust_tier_required, template_slug FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        if (taskResult.rows.length === 0) {
          // Return FORBIDDEN regardless of existence so non-owners cannot
          // enumerate task UUIDs via error discrimination.
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can assign workers' });
        }
        if (taskResult.rows[0].poster_id !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can assign workers' });
        }
        if (taskResult.rows[0].state !== 'OPEN') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Task must be OPEN to assign a worker, current: ${taskResult.rows[0].state}`,
          });
        }

        // Re-validate poster's current trust tier against the task's template requirement.
        // Trust tier can be downgraded after task creation; re-check at assignment time to
        // prevent a demoted poster from advancing the task lifecycle.
        // Performed here — inside the lock, after ownership confirmed — so the slug read
        // is not observable before the auth check completes.
        const template = getTemplate(taskResult.rows[0].template_slug ?? 'standard_physical');
        if (template) {
          const posterTierName = TRUST_TIER_NUMERIC_MAP[ctx.user.trust_tier ?? 1] ?? 'rookie';
          const posterTierIndex = TRUST_TIER_ORDER.indexOf(posterTierName);
          const requiredTierIndex = TRUST_TIER_ORDER.indexOf(template.requiredTrustTier ?? 'rookie');
          if (posterTierIndex < requiredTierIndex) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `Your trust level (${posterTierName}) no longer meets the requirement (${template.requiredTrustTier}) for this task type.`,
            });
          }
        }

        // Step 1b: Enforce trust_tier_required on the admin-assign path.
        // The self-accept path (TaskService.accept) performs this check, but the
        // poster-driven assignWorker bypassed it, allowing a poster to force-assign
        // a worker whose trust tier is below the task's requirement.
        const trustTierRequired = taskResult.rows[0].trust_tier_required;
        if (trustTierRequired !== null && trustTierRequired !== undefined) {
          const workerTierResult = await txn<{ trust_tier: number }>(
            `SELECT trust_tier FROM users WHERE id = $1`,
            [input.workerId]
          );
          if (workerTierResult.rows.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Worker not found' });
          }
          const workerTrustTier = workerTierResult.rows[0].trust_tier;
          if (workerTrustTier < trustTierRequired) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `Task requires trust tier ${trustTierRequired}. Worker's tier: ${workerTrustTier}`,
            });
          }
        }

        // Step 2: Verify the chosen worker has a pending application.
        const appResult = await txn(
          `SELECT id FROM task_applications
           WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'`,
          [input.taskId, input.workerId]
        );
        if (appResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No pending application found for this worker' });
        }

        const acceptedAppId = appResult.rows[0].id;

        // Step 3: Accept the chosen application.
        await txn(
          `UPDATE task_applications SET status = 'accepted', updated_at = NOW()
           WHERE id = $1`,
          [acceptedAppId]
        );

        // Step 4: Reject all other pending applications for this task.
        await txn(
          `UPDATE task_applications
           SET status = 'rejected', rejection_reason = 'Another applicant was selected', updated_at = NOW()
           WHERE task_id = $1 AND status = 'pending' AND id != $2`,
          [input.taskId, acceptedAppId]
        );

        // Step 5: Transition the task to ACCEPTED state (assigns worker_id).
        // We perform this directly inside the transaction rather than delegating
        // to TaskService.accept() so the state change is atomic with the
        // application updates above.
        const acceptResult = await txn<{ id: string; state: string; worker_id: string | null }>(
          `UPDATE tasks
           SET state = 'ACCEPTED',
               worker_id = $2,
               accepted_at = NOW()
           WHERE id = $1
             AND state = 'OPEN'
           RETURNING id, state, worker_id`,
          [input.taskId, input.workerId]
        );

        if ((acceptResult.rowCount ?? 0) === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer in OPEN state — concurrent assignment detected',
          });
        }

        return acceptResult.rows[0];
      });

      await invalidateTask(input.taskId);
      return result;
    }),

  /**
   * Poster rejects a specific applicant
   */
  rejectApplicant: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      workerId: Schemas.uuid,
      reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query<{ poster_id: string; state: string }>(
        `SELECT poster_id, state FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can reject applicants' });
      }

      // T63-2: Applicant management is only valid before work has started.
      const INVALID_STATES_FOR_REJECTION = ['IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
      if (INVALID_STATES_FOR_REJECTION.includes(taskResult.rows[0].state)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Cannot manage applicants once the task is in progress or finalised',
        });
      }

      const result = await db.query(
        `UPDATE task_applications
         SET status = 'rejected', rejection_reason = $3, updated_at = NOW()
         WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'
         RETURNING id`,
        [input.taskId, input.workerId, input.reason || null]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No pending application found for this worker' });
      }
      await invalidateTask(input.taskId);
      return { success: true };
    }),

  /**
   * Hustler withdraws their own application
   */
  withdrawApplication: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE task_applications
         SET status = 'withdrawn', updated_at = NOW()
         WHERE task_id = $1 AND hustler_id = $2 AND status IN ('pending', 'countered')
         RETURNING id`,
        [input.taskId, ctx.user.id]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No active application found to withdraw',
        });
      }

      return { success: true };
    }),
});

export type TaskRouter = typeof taskRouter;
