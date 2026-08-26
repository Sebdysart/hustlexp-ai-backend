/**
 * Action Links Router
 *
 * Replaces Supabase edge functions: action-link-public, action-link-admin
 *
 * Public bearer-link handlers only — /api/action-link?token=<token>.
 * Administrative link creation and mutation remain disabled until an
 * authenticated, audited command boundary is available.
 */

import { router } from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import crypto from 'crypto';

const log = logger.child({ router: 'web.actionLinks' });

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
      trust_note: 'Do not start until payment is confirmed and HustleXP marks you assigned.',
    };
  }
  return {
    title: m.title,
    summary: m.summary,
    scope_checklist: m.scope_checklist,
    payment_status_label: m.payment_status_label ?? 'Waiting for payment',
    next_step: m.next_step,
    helper_readiness: m.helper_readiness,
    pay_url: m.pay_url,
    trust: m.trust,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const webActionLinksRouter = router({});

// ── Public Hono handler (called from server.ts) ───────────────────────────────
// This is a raw handler because action-link-public must be fully unauthenticated.

export async function handleActionLinkGet(token: string): Promise<{
  ok: boolean; link?: object; code?: string;
}> {
  if (!token) return { ok: false, code: 'missing_token' };

  const hash = hashToken(token);
  const result = await db.query<ActionLinkRow>(
    `SELECT id, link_type, role, status, expires_at, allowed_actions, metadata
     FROM action_links WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return { ok: false, code: 'not_found' };
  const link = result.rows[0];

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

export async function handleActionLinkPost(token: string, action: string): Promise<{
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

  if (isExpired(link.expires_at)) return { ok: false, code: 'expired' };
  if (!link.allowed_actions.includes(action)) return { ok: false, code: 'action_not_allowed' };

  // Record event
  await db.query(
    `INSERT INTO action_link_events (action_link_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [link.id, action, JSON.stringify({ action })]
  );

  await db.query(
    `UPDATE action_links SET status = 'action_taken', updated_at = now() WHERE id = $1`,
    [link.id]
  );

  log.info({ linkId: link.id, action }, 'Action link action taken');
  return { ok: true, status: 'action_taken' };
}
