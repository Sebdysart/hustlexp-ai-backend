/**
 * Action Links Router
 *
 * Replaces Supabase edge functions: action-link-public, action-link-admin
 *
 * Public  — /api/action-link?token=<token>  (GET resolve, POST act)
 * Admin reads require a named Firebase operator with can_manage_operations.
 * Creation remains held; expiry uses the versioned two-person containment rail.
 */

import { z } from 'zod';
import {
  heldOperationsAdminProcedure,
  operationsAdminProcedure,
  operationsStepUpProcedure,
  router,
} from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';
import { OperatorAuthorityService } from '../../services/OperatorAuthorityService.js';

const log = logger.child({ router: 'web.actionLinks' });
const LEGACY_MUTATION_HELD_MESSAGE =
  'Legacy action-link writes are held. Use a separately approved, versioned two-person command path.';
const PAYMENT_CREATION_HELD_MESSAGE =
  'Payment creation is frozen. This link cannot expose or execute a pay action.';

function holdLegacyMutation(): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LEGACY_MUTATION_HELD_MESSAGE });
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActionLinkRow {
  id: string;
  link_type: string;
  role: string;
  status: string;
  expires_at: Date;
  allowed_actions: string[];
  metadata: Record<string, unknown>;
}

function suppressPaymentSurfaces<T extends Pick<ActionLinkRow, 'allowed_actions' | 'metadata'>>(row: T): T {
  const metadata = { ...row.metadata };
  delete metadata.pay_url;
  return {
    ...row,
    allowed_actions: row.allowed_actions.filter((action) => action !== 'pay'),
    metadata,
  };
}

function buildDisplay(link: ActionLinkRow): Record<string, unknown> {
  const m = link.metadata;
  if (link.role === 'hustler') {
    return {
      headline: (m.title as string) ?? 'Possible HustleXP job',
      greeting: 'Hey —',
      title: m.title,
      summary: m.summary,
      area_label: m.area_label,
      eta_label: m.eta_label,
      payout_label: m.payout_label,
      requirements: m.requirements,
      payment_status: m.payment_status,
      assignment_status: m.assignment_status,
      connect_status: m.connect_status,
      trust_note: 'Interest is not assignment. Do not start until a separately approved work order exists.',
    };
  }
  const nextStep = typeof m.next_step === 'string' && /pay|payment|checkout|charge/i.test(m.next_step)
    ? 'Scope and estimate review only; payment creation is currently unavailable.'
    : m.next_step;
  return {
    title: m.title,
    summary: m.summary,
    scope_checklist: m.scope_checklist,
    payment_status_label: 'Payment creation unavailable',
    next_step: nextStep,
    helper_readiness: m.helper_readiness,
    trust: m.trust,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const webActionLinksRouter = router({

  // ── Admin: create action link ───────────────────────────────────────────────
  create: heldOperationsAdminProcedure
    .input(z.object({
      link_type: z.enum(['hustler_activation', 'poster_scope']),
      lead_id: z.string().uuid().optional(),
      hustler_id: z.string().uuid().optional(),
      task_id: z.string().uuid().optional(),
      quote_id: z.string().uuid().optional(),
      ttl_hours: z.number().min(1).max(720).default(72),
      created_by: z.string().optional(),
      // Metadata fields
      title: z.string().optional(),
      summary: z.string().optional(),
      area_label: z.string().optional(),
      eta_label: z.string().optional(),
      payout_label: z.string().optional(),
      payout_cents: z.number().optional(),
      requirements: z.array(z.string()).optional(),
      payment_status: z.string().optional(),
      assignment_status: z.string().optional(),
      connect_status: z.string().optional(),
      scope_checklist: z.array(z.string()).optional(),
      payment_status_label: z.string().optional(),
      next_step: z.string().optional(),
      helper_readiness: z.string().optional(),
    }))
    .mutation(holdLegacyMutation),

  // ── Admin: list links ───────────────────────────────────────────────────────
  list: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      hustler_id: z.string().uuid().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.hustler_id) conditions.push(`hustler_id = $${params.push(input.hustler_id)}`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(input.limit);

      const result = await db.query<ActionLinkRow & Record<string, unknown>>(
        `SELECT id, link_type, role, lead_id, hustler_id, task_id,
                array_remove(allowed_actions, 'pay') AS allowed_actions,
                expires_at, status, metadata - 'pay_url' AS metadata, created_by,
                created_at, last_opened_at, updated_at, version
         FROM action_links ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );

      return { ok: true, links: result.rows.map(suppressPaymentSurfaces) };
    }),

  // ── Admin: update status ────────────────────────────────────────────────────
  updateStatus: operationsStepUpProcedure
    .input(z.object({
      id: z.string().uuid(),
      status: z.literal('expired'),
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().uuid(),
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(({ ctx, input }) => OperatorAuthorityService.request(ctx, {
      operationType: 'EXPIRE_ACTION_LINK',
      targetId: input.id,
      targetExpectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    })),
});

// ── Public Hono handler (called from server.ts) ───────────────────────────────
// This is a raw handler because action-link-public must be fully unauthenticated.

export async function handleActionLinkGet(token: string): Promise<{
  ok: boolean; link?: object; code?: string;
}> {
  if (!token) return { ok: false, code: 'missing_token' };

  const hash = hashToken(token);
  const result = await db.query<ActionLinkRow>(
    `SELECT id, link_type, role, status, expires_at,
            array_remove(allowed_actions, 'pay') AS allowed_actions,
            metadata - 'pay_url' AS metadata
     FROM action_links WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return { ok: false, code: 'not_found' };
  const link = suppressPaymentSurfaces(result.rows[0]);

  if (isExpired(link.expires_at)) {
    await db.query(
      `UPDATE action_links SET status = 'expired', updated_at = now() WHERE id = $1`,
      [link.id]
    );
    return { ok: false, code: 'expired' };
  }

  // Mark opened
  await db.query(
    `UPDATE action_links SET last_opened_at = now(), updated_at = now(),
       status = CASE WHEN status = 'link_created' OR status = 'link_sent'
                     THEN 'link_opened' ELSE status END
     WHERE id = $1`,
    [link.id]
  );

  return {
    ok: true,
    link: {
      link_type: link.link_type,
      role: link.role,
      status: link.status,
      expires_at: link.expires_at,
      allowed_actions: link.allowed_actions,
      display: buildDisplay(link),
    },
  };
}

export async function handleActionLinkPost(token: string, action: string, note?: string): Promise<{
  ok: boolean; status?: string; code?: string;
}> {
  if (!token || !action) return { ok: false, code: 'missing_params' };

  const hash = hashToken(token);
  const result = await db.query<ActionLinkRow>(
    `SELECT id, link_type, role, status, expires_at, allowed_actions, metadata
     FROM action_links WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return { ok: false, code: 'not_found' };
  const link = result.rows[0];
  const normalizedAction = action.trim().toLowerCase();

  if (isExpired(link.expires_at)) return { ok: false, code: 'expired' };
  if (normalizedAction === 'pay') {
    log.warn({ linkId: link.id }, PAYMENT_CREATION_HELD_MESSAGE);
    return { ok: false, code: 'payment_creation_frozen' };
  }
  if (!link.allowed_actions.includes(normalizedAction)) return { ok: false, code: 'action_not_allowed' };

  const normalizedNote = typeof note === 'string' ? note.trim() : '';
  if (normalizedNote && normalizedAction !== 'ask_question') {
    return { ok: false, code: 'note_not_allowed' };
  }
  if (normalizedAction === 'ask_question' && (normalizedNote.length < 1 || normalizedNote.length > 2000)) {
    return { ok: false, code: 'invalid_note' };
  }
  const eventPayload = normalizedNote
    ? { action: normalizedAction, note: normalizedNote }
    : { action: normalizedAction };

  // Record event
  await db.query(
    `INSERT INTO action_link_events (action_link_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [link.id, normalizedAction, JSON.stringify(eventPayload)]
  );

  await db.query(
    `UPDATE action_links SET status = 'action_taken', updated_at = now() WHERE id = $1`,
    [link.id]
  );

  log.info({ linkId: link.id, action: normalizedAction }, 'Action link action taken');
  return { ok: true, status: 'action_taken' };
}
