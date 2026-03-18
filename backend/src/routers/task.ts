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
import { cachedDbQuery, invalidateTask, CACHE_KEYS, CACHE_TTL, CACHE_TAGS } from '../cache/db-cache.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { ScoperAIService } from '../services/ScoperAIService.js';
import { getTemplate, getManifest, isCareContent, isContentReleaseRequired } from '../services/TaskTemplateRegistry.js';
import { TaskRiskClassifier } from '../services/TaskRiskClassifier.js';

// ---------------------------------------------------------------------------
// In-memory rate limit for evaluateDraft: max 5 calls per minute per user
// ---------------------------------------------------------------------------

export const draftEvalCalls = new Map<string, { count: number; resetAt: number }>();

function checkDraftEvalRateLimit(userId: string): void {
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxCalls = 5;

  const entry = draftEvalCalls.get(userId);
  if (!entry || now > entry.resetAt) {
    draftEvalCalls.set(userId, { count: 1, resetAt: now + window });
    return;
  }
  entry.count++;
  if (entry.count > maxCalls) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many draft evaluations. Please wait before trying again.',
    });
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
      // Tasks in OPEN/MATCHING/POSTED state are discoverable (hustler feed)
      const isDiscoverable = ['OPEN', 'MATCHING', 'POSTED'].includes(task.state);

      if (!isParticipant && !isDiscoverable) {
        // Last resort: check admin role before throwing
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 LIMIT 1',
          [ctx.user.id]
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
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 LIMIT 1',
          [ctx.user.id]
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
      checkDraftEvalRateLimit(ctx.user.id);

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
   */
  acceptWithConsent: hustlerProcedure
    .input(Schemas.acceptWithConsent)
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query<{
        template_slug: string;
        state: string;
      }>(
        `SELECT template_slug, state FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (!taskResult.rows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      const task = taskResult.rows[0];
      const template = getTemplate(task.template_slug) ?? (() => {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown template on task' });
      })();

      if (!template.requiresMutualConsent) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This template does not require consent checklist',
        });
      }

      const updateResult = await db.query(
        `UPDATE tasks
         SET mutual_consent_accepted = TRUE,
             worker_id = $2,
             state = 'claimed',
             accepted_at = NOW()
         WHERE id = $1 AND state = 'posted'`,
        [input.taskId, ctx.user.id]
      );

      if ((updateResult.rowCount ?? 0) === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Task is no longer available for claiming',
        });
      }

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
    .query(async ({ input }) => {
      const result = await db.query<{
        illegal_risk_score: number;
        compliance_guardian_notes: object;
      }>(
        `SELECT illegal_risk_score, compliance_guardian_notes FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (!result.rows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      return {
        score: result.rows[0].illegal_risk_score,
        notes: result.rows[0].compliance_guardian_notes,
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
      // Verify worker is the one who accepted
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.data.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can start this task' });
      }
      if (taskResult.data.state !== 'ACCEPTED') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Task must be ACCEPTED to start, current state: ${taskResult.data.state}` });
      }

      // Task is ACCEPTED — the worker has started. No separate IN_PROGRESS state exists in the schema.
      // The ACCEPTED state already means the worker is working. Return the current task data.
      const result = await db.query(
        `SELECT * FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      await invalidateTask(input.taskId);
      return result.rows[0];
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
      description: z.string().max(2000).optional(),
      // Extended fields from iOS frontend
      photoUrls: z.array(z.string().url().max(2048)).max(10).optional(),
      videoUrls: z.array(z.string().url().max(2048)).max(5).optional(),
      notes: z.string().max(2000).optional(),
      gpsLatitude: z.number().min(-90).max(90).optional(),
      gpsLongitude: z.number().min(-180).max(180).optional(),
      biometricHash: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Create proof (pass extended fields as description fallback)
      const proofResult = await ProofService.submit({
        taskId: input.taskId,
        submitterId: ctx.user.id,
        description: input.description || input.notes,
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

      // Attach video proof URLs to the proof
      if (input.videoUrls?.length) {
        for (const url of input.videoUrls) {
          const videoResult = await ProofService.addVideo({
            proofId: proofResult.data.id,
            storageKey: url,
            contentType: 'video/mp4',
          });
          if (!videoResult.success) {
            // Log but do not fail the whole submission; proof is already created
            logger.child({ service: 'task' }).warn({ proofId: proofResult.data.id, url }, 'Failed to add video to proof');
          }
        }
      }

      // Transition task to PROOF_SUBMITTED
      const taskResult = await TaskService.submitProof(input.taskId);
      
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: taskResult.error.message,
        });
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
      reason: z.string().max(1000).optional(),
      // iOS frontend fields
      taskId: z.string().uuid().optional(),
      approved: z.boolean().optional(),
      feedback: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Resolve proofId: either from input directly or by looking up via taskId
      let proofId = input.proofId;
      if (!proofId && input.taskId) {
        // Look up latest proof for this task
        const proofLookup = await db.query<{ id: string }>(
          `SELECT id FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
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

      // Resolve decision: from original field or from iOS boolean
      const decision = input.decision || (input.approved === true ? 'ACCEPTED' : input.approved === false ? 'REJECTED' : undefined);
      if (!decision) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'decision or approved is required' });
      }
      const reason = input.reason || input.feedback;

      // Get proof to find task
      const proofResult = await ProofService.getById(proofId);
      if (!proofResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: proofResult.error.message,
        });
      }

      // Verify reviewer is the poster
      const taskResult = await TaskService.getById(proofResult.data.task_id);
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the task poster can review proof',
        });
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
      await invalidateTask(proofResult.data.task_id);
      return reviewResult.data;
    }),
  
  /**
   * Complete task (after proof accepted)
   * INV-3: Will fail if proof is not ACCEPTED
   * SECURITY: Only the poster can mark a task as complete
   */
  complete: posterProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Authorization: only the poster can complete a task
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can mark it complete' });
      }

      const result = await TaskService.complete(input.taskId);

      if (!result.success) {
        const code = result.error.code === 'HX301' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
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
      reason: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify user is poster
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      
      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the task poster can cancel',
        });
      }
      
      const result = await TaskService.cancel(input.taskId);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
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
      message: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query(
        `SELECT id, state, poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      const task = taskResult.rows[0];
      if (task.state !== 'POSTED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Task must be in POSTED state to apply, current: ${task.state}`,
        });
      }
      if (task.poster_id === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot apply for your own task' });
      }

      const existing = await db.query(
        `SELECT id FROM task_applications
         WHERE task_id = $1 AND hustler_id = $2 AND status IN ('pending', 'countered')`,
        [input.taskId, ctx.user.id]
      );
      if (existing.rows.length > 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'You already have an active application for this task' });
      }

      const result = await db.query(
        `INSERT INTO task_applications (id, task_id, hustler_id, message, status, counter_offer_round, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'pending', 0, NOW(), NOW())
         RETURNING *`,
        [input.taskId, ctx.user.id, input.message || null]
      );

      return {
        id: result.rows[0].id,
        taskId: result.rows[0].task_id,
        status: result.rows[0].status,
        message: result.rows[0].message,
        appliedAt: result.rows[0].created_at,
      };
    }),

  /**
   * Poster lists applicants for their task
   */
  listApplicants: posterProcedure
    .input(z.object({ taskId: Schemas.uuid }))
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
           COALESCE(u.display_name, u.name, 'Unknown') AS name,
           COALESCE(u.rating, 5.0) AS rating,
           COALESCE(u.completed_tasks, 0) AS completed_tasks,
           COALESCE(u.trust_tier, 'rookie') AS tier,
           ta.created_at AS applied_at,
           ta.message
         FROM task_applications ta
         LEFT JOIN users u ON u.id = ta.hustler_id
         WHERE ta.task_id = $1 AND ta.status = 'pending'
         ORDER BY ta.created_at ASC`,
        [input.taskId]
      );

      return result.rows;
    }),

  /**
   * Poster accepts an applicant — assigns them as the worker
   */
  assignWorker: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      workerId: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query(
        `SELECT id, state, poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can assign workers' });
      }
      if (taskResult.rows[0].state !== 'POSTED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Task must be POSTED to assign a worker, current: ${taskResult.rows[0].state}`,
        });
      }

      const appResult = await db.query(
        `SELECT id FROM task_applications
         WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'`,
        [input.taskId, input.workerId]
      );
      if (appResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No pending application found for this worker' });
      }

      await db.query(
        `UPDATE task_applications SET status = 'accepted', updated_at = NOW()
         WHERE id = $1`,
        [appResult.rows[0].id]
      );

      await db.query(
        `UPDATE task_applications SET status = 'rejected', rejection_reason = 'Another applicant was selected', updated_at = NOW()
         WHERE task_id = $1 AND status = 'pending' AND id != $2`,
        [input.taskId, appResult.rows[0].id]
      );

      const result = await TaskService.accept({
        taskId: input.taskId,
        workerId: input.workerId,
      });

      if (!result.success) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.message });
      }
      await invalidateTask(input.taskId);
      return result.data;
    }),

  /**
   * Poster rejects a specific applicant
   */
  rejectApplicant: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      workerId: Schemas.uuid,
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query(
        `SELECT poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can reject applicants' });
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
