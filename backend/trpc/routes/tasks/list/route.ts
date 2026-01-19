/**
 * Task Feed Handler (Phase N5 - Execution Hardening)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/tasks.list
 * Purpose: Feed query with full eligibility enforcement via SQL JOIN
 * Phase: N5 (Execution Hardening)
 * 
 * ============================================================================
 * ELIGIBILITY ENFORCEMENT (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. SQL JOIN AUTHORITY:
 *    ✅ Eligibility MUST be enforced via SQL JOIN with capability_profiles
 *    ✅ Frontend trusts ALL returned tasks are eligible
 *    ❌ NO client-side filtering
 *    ❌ NO post-query filtering
 * 
 * 2. CURRENT IMPLEMENTATION (Phase N5):
 *    - Full eligibility enforcement via SQL JOIN with capability_profiles
 *    - Trade-specific filtering (tasks.required_trade ↔ verified_trades)
 *    - Trust tier gating (tasks.required_trust_tier ↔ capability_profiles.trust_tier)
 *    - Insurance/background check enforcement
 *    - Cursor-based pagination (stable under churn)
 *    - Offset-based pagination (backward compatibility)
 * 
 * AUTHORITY STATEMENT:
 * "Eligibility enforced by SQL JOIN — frontend trusts all returned tasks."
 * 
 * Reference: FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 * Reference: PRODUCT_SPEC §17, ARCHITECTURE §13
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskRow {
  id: string;
  poster_id: string;
  worker_id: string | null;
  title: string;
  description: string;
  requirements: string | null;
  location: string | null;
  category: string | null;
  price: number;
  state: string;
  risk_level: string;
  deadline: Date | null;
  requires_proof: boolean | null;
  created_at: Date;
  updated_at: Date;
}

interface UserRow {
  id: string;
  firebase_uid: string;
}

export const tasksListProcedure = protectedProcedure
  .input(
    z.object({
      category: z.string().optional(),
      city: z.string().optional(),
      status: z.string().optional(), // Legacy support, maps to state
      limit: z.number().default(20),
      offset: z.number().default(0),
      cursor: z.string().uuid().optional(), // For future cursor-based pagination
    })
  )
  .query(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // Step 0: Get database user_id from Firebase UID
    const userResult = await db.query<UserRow>(
      `
      SELECT id
      FROM users
      WHERE firebase_uid = $1
      LIMIT 1
      `,
      [firebaseUid]
    );

    if (userResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    // Step 1: Build eligibility JOIN query
    // N5 ENFORCEMENT: Full eligibility enforced via SQL JOIN
    // - Trade-specific: JOIN with verified_trades if required_trade is set
    // - Trust tier: Compare capability_profiles.trust_tier >= tasks.required_trust_tier
    // - Insurance: capability_profiles.insurance_valid = true if insurance_required
    // - Background check: capability_profiles.background_check_valid = true if background_check_required
    
    let joinClause = `
      INNER JOIN capability_profiles cp ON cp.user_id = $1
    `;
    
    // LEFT JOIN with verified_trades if task requires a specific trade
    // This allows tasks with required_trade = NULL to be seen by all (no trade filter)
    let whereClause = `
      t.state = 'OPEN'
      AND cp.user_id = $1
      AND (
        t.required_trade IS NULL 
        OR EXISTS (
          SELECT 1 FROM verified_trades vt
          WHERE vt.user_id = $1
            AND vt.trade = t.required_trade
            AND (vt.expires_at IS NULL OR vt.expires_at > NOW())
        )
      )
      AND (
        t.required_trust_tier IS NULL
        OR (
          CASE cp.trust_tier
            WHEN 'A' THEN 4
            WHEN 'B' THEN 3
            WHEN 'C' THEN 2
            WHEN 'D' THEN 1
            ELSE 0
          END >=
          CASE t.required_trust_tier
            WHEN 'A' THEN 4
            WHEN 'B' THEN 3
            WHEN 'C' THEN 2
            WHEN 'D' THEN 1
            ELSE 0
          END
        )
      )
      AND (t.insurance_required = false OR cp.insurance_valid = true)
      AND (t.background_check_required = false OR cp.background_check_valid = true)
    `;
    const queryParams: any[] = [userId];
    let paramIndex = 2;

    // Step 2: Apply optional filters
    if (input.category) {
      whereClause += ` AND t.category = $${paramIndex}`;
      queryParams.push(input.category);
      paramIndex++;
    }

    if (input.city) {
      whereClause += ` AND t.location ILIKE $${paramIndex}`;
      queryParams.push(`%${input.city}%`);
      paramIndex++;
    }

    // Legacy status filter support (maps to state)
    if (input.status) {
      const statusMap: Record<string, string> = {
        active: 'OPEN',
        open: 'OPEN',
        pending: 'ACCEPTED',
        completed: 'COMPLETED',
        cancelled: 'CANCELLED',
      };
      
      const mappedState = statusMap[input.status.toLowerCase()] || input.status.toUpperCase();
      if (mappedState === 'OPEN') {
        // Already filtered by state = 'OPEN' above
      } else {
        whereClause += ` AND t.state = $${paramIndex}`;
        queryParams.push(mappedState);
        paramIndex++;
      }
    }

    // N5.5: Cursor-based pagination (stable ordering under churn)
    // Use cursor if provided, otherwise fall back to offset
    if (input.cursor) {
      // Get cursor timestamp from task ID (we'll use created_at for cursor)
      const cursorTask = await db.query<{ created_at: Date }>(
        `SELECT created_at FROM tasks WHERE id = $1 LIMIT 1`,
        [input.cursor]
      );
      
      if (cursorTask.rows.length > 0) {
        // Use created_at < cursor for next page (DESC order)
        whereClause += ` AND (t.created_at < $${paramIndex} OR (t.created_at = $${paramIndex} AND t.id < $${paramIndex + 1}))`;
        queryParams.push(cursorTask.rows[0].created_at, input.cursor);
        paramIndex += 2;
      }
    }

    // Step 3: Execute query with full eligibility JOIN
    // N5 AUTHORITY: Frontend trusts all returned tasks are eligible
    // All eligibility criteria enforced at SQL level (trade, trust tier, insurance, background check)
    const tasksResult = await db.query<TaskRow>(
      `
      SELECT 
        t.id,
        t.poster_id,
        t.worker_id,
        t.title,
        t.description,
        t.requirements,
        t.location,
        t.category,
        t.price,
        t.state,
        t.risk_level,
        t.deadline,
        t.requires_proof,
        t.required_trade,
        t.required_trust_tier,
        t.insurance_required,
        t.background_check_required,
        t.created_at,
        t.updated_at
      FROM tasks t
      ${joinClause}
      WHERE ${whereClause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${paramIndex}${input.cursor ? '' : ` OFFSET $${paramIndex + 1}`}
      `,
      input.cursor 
        ? [...queryParams, input.limit]
        : [...queryParams, input.limit, input.offset]
    );

    // Step 4: Transform to frontend format
    const tasks = tasksResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category || 'other',
      price: row.price / 100, // Convert cents to dollars
      status: row.state.toLowerCase() as 'open' | 'accepted' | 'working' | 'completed' | 'cancelled',
      location: {
        address: row.location || '',
        city: row.location?.split(',')[0] || '',
      },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      posterId: row.poster_id,
      workerId: row.worker_id,
      deadline: row.deadline?.toISOString(),
      requiresProof: row.requires_proof || false,
      riskLevel: row.risk_level,
    }));

    // Step 5: Calculate pagination metadata
    // N5.5: Cursor-based pagination metadata
    const hasMore = tasks.length === input.limit;
    const nextCursor = hasMore && tasks.length > 0 ? tasks[tasks.length - 1].id : undefined;

    console.log('[Task Feed] Fetched for user:', userId, 'count:', tasks.length, 'hasMore:', hasMore, 'cursor:', input.cursor, 'nextCursor:', nextCursor);

    return {
      tasks,
      total: tasks.length, // NOTE: This is page size, not total count
      hasMore,
      // N5.5: Cursor for cursor-based pagination (stable under churn)
      nextCursor,
    };
  });
