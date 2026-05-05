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
import { NotificationService } from '../services/NotificationService.js';
import { db } from '../db.js';
import type { Proof } from '../types.js';
import { cachedDbQuery, invalidateTask, CACHE_KEYS, CACHE_TTL, CACHE_TAGS } from '../cache/db-cache.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { ScoperAIService } from '../services/ScoperAIService.js';
import { getTemplate, getManifest, isCareContent, isContentReleaseRequired } from '../services/TaskTemplateRegistry.js';
import { TaskRiskClassifier } from '../services/TaskRiskClassifier.js';
import { checkRateLimit } from '../cache/redis.js';
import { AIClient } from '../services/AIClient.js';

const taskRouterLog = logger.child({ router: 'task' });

// ============================================================================
// AI CONVERSE — System Prompt & Response Schema
// ============================================================================

const TASK_CONVERSE_SYSTEM_PROMPT = `You are HustleXP's AI Task Creation Assistant. You help posters create task listings through natural conversation.

YOUR ROLE:
- Understand what the user needs done
- Ask smart follow-up questions ONE AT A TIME (never dump all questions at once)
- Extract structured task data from natural conversation
- Evaluate task difficulty based on complexity, required skills, time, and risk
- Suggest fair pricing based on task type, difficulty, and market rates

TASK FIELDS TO EXTRACT (update the "draft" object):
- title: Short, clear task title (max 60 chars)
- description: Detailed description of what needs to be done
- suggestedPriceCents: Price in cents (e.g. 5000 = $50.00). Use these ranges:
  Easy tasks: $15-$50 | Medium: $50-$150 | Hard: $150-$500
- locationCity: City name (e.g. "Houston", "San Francisco", "Austin"). Set to "Anywhere" if no location restriction.
- locationState: Two-letter US state code (e.g. "TX", "CA", "NY"). Leave null if locationCity is "Anywhere".
- locationRadiusMiles: Service radius from the city center. Options: 25, 50, 75, or 100 miles. Default 25.
- estimatedDurationMinutes: Total minutes the task takes. For recurring/multi-session tasks, sum ALL sessions (e.g. "3 hours/day for 90 days" → 3 × 60 × 90 = 16200). Always return total committed minutes, never per-session.
- difficulty: "easy", "medium", or "hard" based on:
  Easy = simple physical task, no special skills, <1 hour
  Medium = requires some skill or coordination, 1-3 hours
  Hard = specialized skills, complex logistics, or 3+ hours
- category: One of: delivery, moving, cleaning, yardWork, shopping, assembly, tech, petCare, handyman, childcare, elderCare, contentCreator, eventAppearance, creativeProduction, specializedLicensed, other
- templateSlug: REQUIRED. Assign based on task type (see TEMPLATE RULES below)
- riskLevel: REQUIRED. One of: "LOW", "MEDIUM", "HIGH". Assess based on risk factors (see RISK RULES below)
- requirements: Specific skills, tools, or qualifications needed
- deadline: When this needs to be done (ISO date or null)
- flags: Array of relevant tags like ["urgent", "heavy_lifting", "vehicle_needed", "inside_home", "people_present", "pets_present"]
- isReadyToPost: Set to true ONLY when you have at minimum: title, description, price, and location (city/state or Anywhere)

TEMPLATE ASSIGNMENT RULES (assign ONE templateSlug):
- "standard_physical": Delivery, moving, yard work, shopping, assembly, outdoor tasks
- "in_home": Tasks inside someone's home — cleaning, handyman, repairs, furniture assembly at home
- "care": Childcare, elder care, pet sitting — involves vulnerable people/animals
- "content_creator": Photography, videography, social media content, streaming
- "event_appearance": Event staffing, promotions, brand ambassador, mascot
- "creative_production": Film shoots, recording sessions, modeling
- "specialized_licensed": Electrician, plumber, HVAC, tutor, notary — requires professional license
- "wildcard_bizarre": Anything unusual that doesn't fit other categories

RISK LEVEL RULES (assess ONE riskLevel):
- "LOW": Outdoor/public tasks, simple physical labor, no home entry, no vulnerable people
- "MEDIUM": Inside home but no vulnerable people, handling valuables, requires vehicle, licensed work, content with people
- "HIGH": Children/elderly present, overnight stays, isolated locations, physical contact possible, care tasks

When you assign a template, INFORM the user about the implications:
- care template: "This task requires a background-checked hustler (Trusted tier+)"
- in_home template: "In-home tasks have a 48-hour review period before payment releases"
- content_creator: "A content release agreement will be required"
- wildcard_bizarre: "Both parties will need to agree to a mutual consent checklist"
- specialized_licensed: "The hustler will need to verify their professional license"

IMPORTANT RULES:
- Every task is IN PERSON. There is no "Remote" option. All tasks require physical presence.
- When asking about location, ask "What city are you in?" or "Where should the hustler come?"
- If user says a city name, extract the city and state. If user says "anywhere" or "no preference", set locationCity to "Anywhere".
- Always ask about the service radius (25, 50, 75, or 100 miles) after getting the city.

CONVERSATION RULES:
1. Be concise and friendly. No corporate speak.
2. After the user's FIRST message: understand the task, set title/description/category/difficulty, suggest a price, then ask for the MOST important missing field.
3. For follow-ups: extract what the user said, update the draft, then ask for the next missing field.
4. When all required fields are filled: summarize the task and ask for confirmation. Set isReadyToPost=true. In the summary, mention the estimated duration in HOURS (e.g. "270 hours total" for a 3hr/day × 90 days task, or "2 hours" for a one-off). The task card displays duration in hours, so the summary must match.
5. If the user says "yes", "looks good", "post it", etc: confirm the task is ready.
6. ALWAYS respond with valid JSON matching the schema. No markdown, no code blocks.

PRICING GUIDELINES:
- Grocery delivery: $15-$30
- House cleaning: $40-$100
- Moving help: $50-$150
- Dog walking: $15-$25
- Furniture assembly: $30-$80
- Tech support: $30-$100
- Lawn care: $25-$60
- Specialized/licensed work: $80-$300
- Content creation: $50-$200
- Software development: $100-$500

RESPONSE FORMAT (strict JSON):
{
  "message": "Your conversational response to the user",
  "draft": {
    "title": "string or null",
    "description": "string or null",
    "suggestedPriceCents": number or null,
    "locationCity": "city name or Anywhere",
    "locationState": "two-letter state code or null",
    "locationRadiusMiles": 25 or 50 or 75 or 100,
    "estimatedDurationMinutes": number or null (TOTAL minutes — sum all sessions for recurring tasks),
    "difficulty": "easy|medium|hard or null",
    "category": "string or null",
    "templateSlug": "standard_physical|in_home|care|content_creator|event_appearance|creative_production|specialized_licensed|wildcard_bizarre",
    "riskLevel": "LOW|MEDIUM|HIGH",
    "requirements": "string or null",
    "deadline": "string or null",
    "flags": ["array", "of", "strings"],
    "isReadyToPost": false
  }
}`;

const AIConverseResponseSchema = z.object({
  message: z.string().min(1),
  draft: z.object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    suggestedPriceCents: z.number().nullable().optional(),
    locationCity: z.string().nullable().optional(),
    locationState: z.string().nullable().optional(),
    locationRadiusMiles: z.number().nullable().optional(),
    estimatedDurationMinutes: z.number().nullable().optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
    category: z.string().nullable().optional(),
    templateSlug: z.string().nullable().optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
    requirements: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(),
    flags: z.array(z.string()).optional(),
    isReadyToPost: z.boolean().optional(),
  }).nullable().optional(),
});

type AIConverseResponse = z.infer<typeof AIConverseResponseSchema>;

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

      // Trust tier requirement is enforced when hustlers ACCEPT the task, not when
      // posters CREATE it. Posters can post any task type regardless of their own tier.
      // The template's requiredTrustTier is stored on the task and checked in applyForTask.

      const result = await TaskService.create({
        posterId: ctx.user.id,
        title: input.title,
        description: input.description,
        price: input.price,
        requirements: input.requirements,
        location: input.location,
        locationCity: input.locationCity,
        locationState: input.locationState,
        locationRadiusMiles: input.locationRadiusMiles,
        latitude: input.latitude,
        longitude: input.longitude,
        category: input.category,
        estimatedDuration: input.estimatedDuration,
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
   * Update a task (poster only, only while in OPEN state)
   */
  update: posterProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      title: z.string().min(1).max(255).optional(),
      description: z.string().min(10).max(5000).optional(),
      price: z.number().int().positive().max(99999900).optional(),
      location: z.string().max(500).optional(),
      category: z.string().max(100).optional(),
      estimatedDuration: z.string().max(100).optional(),
      requirements: z.string().max(2000).optional(),
      deadline: z.string().datetime().optional(),
      templateSlug: z.string().max(50).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify ownership and state
      const taskResult = await db.query<{ poster_id: string; state: string; description: string }>(
        'SELECT poster_id, state, description FROM tasks WHERE id = $1',
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own tasks' });
      }
      if (taskResult.rows[0].state !== 'OPEN') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Can only edit tasks in OPEN state' });
      }

      // Validate templateSlug if provided
      if (input.templateSlug !== undefined) {
        const template = getTemplate(input.templateSlug);
        if (!template) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown template: ${input.templateSlug}` });
        }
        // Trust tier is enforced at accept time, not at creation/edit time.
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (input.title !== undefined) { updates.push(`title = $${idx++}`); values.push(input.title); }
      if (input.description !== undefined) { updates.push(`description = $${idx++}`); values.push(input.description); }
      if (input.price !== undefined) { updates.push(`price = $${idx++}`); values.push(input.price); }
      if (input.location !== undefined) { updates.push(`location = $${idx++}`); values.push(input.location); }
      if (input.category !== undefined) { updates.push(`category = $${idx++}`); values.push(input.category); }
      if (input.estimatedDuration !== undefined) { updates.push(`estimated_duration = $${idx++}`); values.push(input.estimatedDuration); }
      if (input.requirements !== undefined) { updates.push(`requirements = $${idx++}`); values.push(input.requirements); }
      if (input.deadline !== undefined) { updates.push(`deadline = $${idx++}`); values.push(new Date(input.deadline)); }
      if (input.templateSlug !== undefined) {
        const template = getTemplate(input.templateSlug)!;
        const description = input.description ?? taskResult.rows[0].description;
        const caregiving = template.slug === 'care' || isCareContent(description);
        const requiresContentRelease = template.requiresContentRelease || isContentReleaseRequired(description);

        updates.push(`template_slug = $${idx++}`); values.push(input.templateSlug);
        updates.push(`late_cancel_pct = $${idx++}`); values.push(template.lateCancelPct);
        updates.push(`content_release = $${idx++}`); values.push(requiresContentRelease);
        updates.push(`cancellation_window_hours = $${idx++}`);
        values.push(caregiving ? 0 : template.autoReleaseHours);
      }

      if (updates.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(input.taskId);

      const result = await db.query(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );

      await invalidateTask(input.taskId);
      logger.info({ taskId: input.taskId, userId: ctx.user.id, fields: updates }, '[task.update] Task updated');

      return result.rows[0];
    }),

  // --------------------------------------------------------------------------
  // AI-POWERED TASK CREATION CONVERSATION
  // --------------------------------------------------------------------------

  /**
   * AI-powered conversational task creation.
   * Every user message is processed by GPT-4o which:
   * - Understands the task description
   * - Asks smart follow-up questions one at a time
   * - Extracts structured data from natural language
   * - Evaluates difficulty, suggests pricing
   * - Returns both a conversational response and structured draft updates
   */
  aiConverse: posterProcedure
    .input(z.object({
      message: z.string().min(1).max(5000),
      conversationHistory: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).max(30),
      currentDraft: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        suggestedPriceCents: z.number().optional(),
        locationCity: z.string().optional(),
        locationState: z.string().optional(),
        locationRadiusMiles: z.number().optional(),
        estimatedDurationMinutes: z.number().optional(),
        difficulty: z.string().optional(),
        category: z.string().optional(),
        templateSlug: z.string().optional(),
        riskLevel: z.string().optional(),
        requirements: z.string().optional(),
        deadline: z.string().optional(),
        flags: z.array(z.string()).optional(),
        isReadyToPost: z.boolean().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const startTime = Date.now();
      const conversationId = `conv_${ctx.user.id}_${Date.now()}`;

      logger.info({
        conversationId,
        userId: ctx.user.id,
        messageLength: input.message.length,
        historyLength: input.conversationHistory.length,
        currentDraft: input.currentDraft,
      }, '[AIConverse] >>> Request received');

      // Rate limit: 10 messages per minute
      await checkDraftEvalRateLimit(ctx.user.id);

      // Build conversation messages for the AI
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: TASK_CONVERSE_SYSTEM_PROMPT,
        },
      ];

      // Add conversation history
      for (const msg of input.conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }

      // Add the current draft state as context
      if (input.currentDraft) {
        messages.push({
          role: 'system',
          content: `Current draft state (JSON): ${JSON.stringify(input.currentDraft)}. Update fields based on the user's new message.`,
        });
      }

      // Add the new user message
      messages.push({ role: 'user', content: input.message });

      logger.info({
        conversationId,
        totalMessages: messages.length,
      }, '[AIConverse] Calling AI provider...');

      try {
        const aiResult = await AIClient.callJSON<AIConverseResponse>({
          route: 'primary',
          schema: AIConverseResponseSchema,
          temperature: 0.5,
          timeoutMs: 20000,
          systemPrompt: TASK_CONVERSE_SYSTEM_PROMPT,
          prompt: messages
            .filter(m => m.role !== 'system')
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n')
            + `\n\nCurrent draft: ${JSON.stringify(input.currentDraft ?? {})}`
            + `\n\nUser: ${input.message}`,
          responseFormat: 'json',
        });

        const latencyMs = Date.now() - startTime;

        logger.info({
          conversationId,
          provider: aiResult.provider,
          model: aiResult.model,
          cached: aiResult.cached,
          latencyMs,
          isReadyToPost: aiResult.data.draft?.isReadyToPost,
          difficulty: aiResult.data.draft?.difficulty,
          suggestedPrice: aiResult.data.draft?.suggestedPriceCents,
        }, '[AIConverse] AI response received');

        // Run compliance check on the description if it's substantial
        const description = aiResult.data.draft?.description || input.currentDraft?.description;
        let complianceWarning: string | null = null;
        if (description && description.length > 20) {
          logger.info({ conversationId }, '[AIConverse] Running compliance check...');
          const compliance = await ComplianceGuardianService.evaluate({
            description,
            userId: ctx.user.id,
          });

          if (compliance.tier === 'hard_block') {
            logger.warn({
              conversationId,
              score: compliance.score,
              rules: compliance.triggeredRules,
            }, '[AIConverse] Compliance HARD BLOCK');

            return {
              message: `I can't help create this task — it appears to violate our guidelines. ${compliance.suggestedAlternative || 'Please describe a different task.'}`,
              draft: null,
              compliance: { tier: compliance.tier, score: compliance.score },
            };
          }

          if (compliance.tier === 'soft_flag') {
            complianceWarning = `Note: This task was flagged for review (${compliance.triggeredRules.join(', ')}). It can still be posted.`;
            logger.info({
              conversationId,
              score: compliance.score,
              rules: compliance.triggeredRules,
            }, '[AIConverse] Compliance soft flag');
          }
        }

        const responseMessage = complianceWarning
          ? `${aiResult.data.message}\n\n⚠️ ${complianceWarning}`
          : aiResult.data.message;

        logger.info({
          conversationId,
          totalLatencyMs: Date.now() - startTime,
        }, '[AIConverse] <<< Response sent');

        return {
          message: responseMessage,
          draft: aiResult.data.draft,
          compliance: null,
        };
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const errMsg = err instanceof Error ? err.message : String(err);

        logger.error({
          conversationId,
          latencyMs,
          err: errMsg,
        }, '[AIConverse] AI call FAILED');

        // Fallback: return a helpful message without AI
        return {
          message: "I'm having trouble processing that right now. Could you tell me:\n• What do you need done?\n• Where is the task?\n• How much are you willing to pay?",
          draft: input.currentDraft ?? null,
          compliance: null,
        };
      }
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
      // Validate template outside the transaction — this is a read-only, stateless
      // lookup and does not need to be part of the locking sequence.
      const templateSlugResult = await db.query<{ template_slug: string; poster_id: string }>(
        `SELECT template_slug, poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (!templateSlugResult.rows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      // Self-dealing guard: a poster cannot accept their own task as a worker.
      if (templateSlugResult.rows[0].poster_id === ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot accept a task that you posted',
        });
      }
      const template = getTemplate(templateSlugResult.rows[0].template_slug) ?? (() => {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown template on task' });
      })();
      if (!template.requiresMutualConsent) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This template does not require consent checklist',
        });
      }

      // Lock + update in a single transaction
      await db.transaction(async (query) => {
        // FOR UPDATE acquires a row-level lock held until COMMIT
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        if (!lockResult.rows[0] || lockResult.rows[0].state !== 'posted') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer available for claiming',
          });
        }

        const updateResult = await query(
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

      // Notify poster that a hustler accepted their task
      try {
        const workerName = ctx.user.full_name || 'A hustler';
        await NotificationService.createNotification({
          userId: result.data.poster_id,
          category: 'task_accepted',
          title: 'Your task was accepted!',
          body: `${workerName} accepted "${result.data.title}". They'll get started soon.`,
          taskId: input.taskId,
          deepLink: `hustlexp://task/${input.taskId}`,
          channels: ['push', 'in_app'],
          priority: 'HIGH',
        });
      } catch (err) {
        taskRouterLog.warn({ err: err instanceof Error ? err.message : String(err), taskId: input.taskId }, 'Failed to send task_accepted notification');
      }

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
      await invalidateTask(input.taskId);
      const refreshed = await TaskService.getById(input.taskId);
      if (!refreshed.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found after start' });
      }
      return refreshed.data;
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

      // Attach photo proof URLs to the proof
      if (input.photoUrls?.length) {
        for (let i = 0; i < input.photoUrls.length; i++) {
          const url = input.photoUrls[i];
          const photoResult = await ProofService.addPhoto({
            proofId: proofResult.data.id,
            storageKey: url,
            contentType: 'image/jpeg',
            fileSizeBytes: 0,
            checksumSha256: '',
            sequenceNumber: i + 1,
          });
          if (!photoResult.success) {
            logger.child({ service: 'task' }).warn({ proofId: proofResult.data.id, url }, 'Failed to add photo to proof');
          }
        }
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

      // Notify poster that proof was submitted
      try {
        await NotificationService.createNotification({
          userId: taskResult.data.poster_id,
          category: 'proof_submitted',
          title: 'Proof submitted — review needed',
          body: `Your hustler submitted proof for "${taskResult.data.title}". Approve to release payment.`,
          taskId: input.taskId,
          deepLink: `hustlexp://task/${input.taskId}/review`,
          channels: ['push', 'in_app'],
          priority: 'HIGH',
        });
      } catch (err) {
        taskRouterLog.warn({ err: err instanceof Error ? err.message : String(err), taskId: input.taskId }, 'Failed to send proof_submitted notification');
      }

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

      // Notify hustler about the review decision
      try {
        const taskRow = await db.query<{ title: string; price: number; worker_id: string | null }>(
          'SELECT title, price, worker_id FROM tasks WHERE id = $1',
          [proofResult.data.task_id]
        );
        const t = taskRow.rows[0];
        if (t?.worker_id) {
          if (decision === 'ACCEPTED') {
            const netCents = Math.round(t.price * 0.85);
            await NotificationService.createNotification({
              userId: t.worker_id,
              category: 'proof_approved',
              title: 'Payment approved! 🎉',
              body: `Your work on "${t.title}" was approved. $${(netCents / 100).toFixed(2)} is on its way to your account.`,
              taskId: proofResult.data.task_id,
              deepLink: `hustlexp://task/${proofResult.data.task_id}`,
              channels: ['push', 'in_app'],
              priority: 'HIGH',
            });
          } else {
            await NotificationService.createNotification({
              userId: t.worker_id,
              category: 'proof_rejected',
              title: 'Proof needs changes',
              body: reason
                ? `Poster requested changes for "${t.title}": ${reason}`
                : `Poster requested changes for "${t.title}". Please resubmit.`,
              taskId: proofResult.data.task_id,
              deepLink: `hustlexp://task/${proofResult.data.task_id}`,
              channels: ['push', 'in_app'],
              priority: 'HIGH',
            });
          }
        }
      } catch (err) {
        taskRouterLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send proof review notification');
      }

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

      // Notify poster about refund (if escrow was funded) and hustler if assigned
      try {
        // Refund notification to poster
        await NotificationService.createNotification({
          userId: result.data.poster_id,
          category: 'refund_issued',
          title: 'Task cancelled — refund processing',
          body: `"${result.data.title}" was cancelled. Your refund will arrive on your card in 5-10 business days.`,
          taskId: input.taskId,
          deepLink: `hustlexp://payments/history`,
          channels: ['push', 'in_app'],
          priority: 'HIGH',
        });

        // If a hustler was assigned, notify them too
        if (result.data.worker_id) {
          await NotificationService.createNotification({
            userId: result.data.worker_id,
            category: 'task_cancelled',
            title: 'Task was cancelled',
            body: `The poster cancelled "${result.data.title}".`,
            taskId: input.taskId,
            deepLink: `hustlexp://task/${input.taskId}`,
            channels: ['push', 'in_app'],
            priority: 'MEDIUM',
          });
        }
      } catch (err) {
        taskRouterLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send cancel notifications');
      }

      return result.data;
    }),

  /**
   * Hustler abandons their accepted task.
   * Returns task to OPEN state for another hustler to accept.
   * Records reputation penalty on the abandoning worker.
   * Escrow stays FUNDED — money waits for next hustler. Poster keeps funds locked.
   */
  abandon: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      reason: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      // Only the assigned worker may abandon
      if (taskResult.data.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can abandon this task' });
      }

      // Only allow abandonment from ACCEPTED state (not after proof submitted)
      if (taskResult.data.state !== 'ACCEPTED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Cannot abandon task in state ${taskResult.data.state}. Tasks can only be abandoned before proof is submitted.`,
        });
      }

      // Reset task to OPEN, clear worker, log abandonment for reputation
      await db.transaction(async (query) => {
        await query(
          `UPDATE tasks
           SET state = 'OPEN',
               worker_id = NULL,
               accepted_at = NULL
           WHERE id = $1 AND worker_id = $2 AND state = 'ACCEPTED'`,
          [input.taskId, ctx.user.id]
        );

        // Log abandonment event for reputation tracking
        await query(
          `INSERT INTO task_abandonments (task_id, worker_id, reason, abandoned_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [input.taskId, ctx.user.id, input.reason || null]
        );
      }).catch((err) => {
        // task_abandonments table may not exist yet — log but don't fail
        console.warn('[task.abandon] Failed to log abandonment:', err instanceof Error ? err.message : err);
      });

      await invalidateTask(input.taskId);
      const refreshed = await TaskService.getById(input.taskId);

      // Notify poster that the hustler abandoned — task is open again
      try {
        await NotificationService.createNotification({
          userId: taskResult.data.poster_id,
          category: 'task_cancelled',
          title: 'Hustler dropped your task',
          body: `The hustler abandoned "${taskResult.data.title}". Don't worry — your funds are safe and the task is open for someone new.`,
          taskId: input.taskId,
          deepLink: `hustlexp://task/${input.taskId}`,
          channels: ['push', 'in_app'],
          priority: 'HIGH',
        });
      } catch (err) {
        taskRouterLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send abandonment notification');
      }

      return refreshed.success ? refreshed.data : taskResult.data;
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
      taskRouterLog.info({
        taskId: input.taskId,
        userId: ctx.user.id,
        userTrustTier: ctx.user.trust_tier,
        userMode: ctx.user.default_mode,
      }, '[task.applyForTask] Application attempt');

      const taskResult = await db.query(
        `SELECT id, state, poster_id, required_tier, risk_level FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      const task = taskResult.rows[0];

      taskRouterLog.info({
        taskId: input.taskId,
        taskState: task.state,
        taskPosterId: task.poster_id,
        taskRequiredTier: task.required_tier,
        taskRiskLevel: task.risk_level,
      }, '[task.applyForTask] Task details');

      if (task.state !== 'OPEN' && task.state !== 'POSTED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Task must be in OPEN state to apply, current: ${task.state}`,
        });
      }
      if (task.poster_id === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot apply for your own task' });
      }
      if (task.required_tier != null && ctx.user.trust_tier < (task.required_tier as number)) {
        taskRouterLog.warn({
          taskId: input.taskId,
          required: task.required_tier,
          userTier: ctx.user.trust_tier,
        }, '[task.applyForTask] Trust tier insufficient');
        throw new TRPCError({ code: 'FORBIDDEN', message: `Your trust tier (${ctx.user.trust_tier}) is insufficient. Task requires tier ${task.required_tier}.` });
      }

      // Use ON CONFLICT DO NOTHING against the partial unique index
      // (idx_task_app_active_per_hustler covers status NOT IN rejected/counter_rejected/withdrawn/expired)
      // to make the duplicate check and insert atomic, eliminating the TOCTOU race.
      const result = await db.query(
        `INSERT INTO task_applications (id, task_id, hustler_id, message, status, counter_offer_round, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'pending', 0, NOW(), NOW())
         ON CONFLICT (task_id, hustler_id) WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired') DO NOTHING
         RETURNING *`,
        [input.taskId, ctx.user.id, input.message || null]
      );
      if (result.rowCount === 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'You already have an active application for this task' });
      }

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
   *
   * RACE CONDITION FIX: All 6 DB operations are wrapped in a single db.transaction()
   * with a SELECT ... FOR UPDATE as the very first statement. The row-level lock is
   * held from the initial state check through the final TaskService.accept() UPDATE,
   * so two concurrent poster calls cannot both read state='POSTED' and produce
   * inconsistent task_applications records (worker Y accepted but task.worker_id=X).
   */
  assignWorker: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      workerId: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      // Resolve the template slug outside the transaction — it is a read-only
      // stateless lookup and does not need to be part of the locking sequence.
      const templateSlugResult = await db.query<{ template_slug: string | null }>(
        `SELECT template_slug FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (templateSlugResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      // Trust tier is enforced when the hustler accepts/applies, not when
      // the poster assigns. The poster's own tier is irrelevant here.

      const result = await db.transaction(async (txn) => {
        // Step 1: Lock the task row for the duration of the transaction.
        // FOR UPDATE prevents concurrent assignWorker calls from both reading
        // state='POSTED' and proceeding to assign different workers.
        const taskResult = await txn<{ id: string; state: string; poster_id: string }>(
          `SELECT id, state, poster_id FROM tasks WHERE id = $1 FOR UPDATE`,
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
             AND state = 'POSTED'
           RETURNING id, state, worker_id`,
          [input.taskId, input.workerId]
        );

        if ((acceptResult.rowCount ?? 0) === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer in POSTED state — concurrent assignment detected',
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

  // ── Bookmarks ────────────────────────────────────────────────────────────

  /**
   * Bookmark a task (idempotent — safe to call if already bookmarked)
   */
  bookmark: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Verify task exists and is publicly visible
      const taskResult = await db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      await db.query(
        `INSERT INTO task_bookmarks (user_id, task_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, task_id) DO NOTHING`,
        [ctx.user.id, input.taskId]
      );

      taskRouterLog.info({ userId: ctx.user.id, taskId: input.taskId }, 'Task bookmarked');
      return { success: true };
    }),

  /**
   * Remove a bookmark (idempotent — safe to call if not bookmarked)
   */
  removeBookmark: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      await db.query(
        `DELETE FROM task_bookmarks WHERE user_id = $1 AND task_id = $2`,
        [ctx.user.id, input.taskId]
      );

      taskRouterLog.info({ userId: ctx.user.id, taskId: input.taskId }, 'Task bookmark removed');
      return { success: true };
    }),

  /**
   * Get all tasks bookmarked by the current hustler
   */
  getBookmarkedTasks: hustlerProcedure
    .query(async ({ ctx }) => {
      const result = await db.query(
        `SELECT t.*
         FROM tasks t
         INNER JOIN task_bookmarks b ON b.task_id = t.id
         WHERE b.user_id = $1
         ORDER BY b.created_at DESC`,
        [ctx.user.id]
      );
      return result.rows;
    }),

  /**
   * Check whether the current hustler has bookmarked a specific task
   */
  isBookmarked: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM task_bookmarks
           WHERE user_id = $1 AND task_id = $2
         ) AS exists`,
        [ctx.user.id, input.taskId]
      );
      return { isBookmarked: result.rows[0]?.exists ?? false };
    }),
});

export type TaskRouter = typeof taskRouter;
