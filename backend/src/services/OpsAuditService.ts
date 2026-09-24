import { db } from '../db.js';
import { logger } from '../logger.js';
const log = logger.child({module:'ops-audit'});

export async function recordOpsAudit(input: {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
}, query = db.query.bind(db), required = false): Promise<void> {
  try {
    await query(
      `INSERT INTO ops_action_audit (actor_user_id, actor_label, action, target_type, target_id, meta)
       VALUES ($1, 'ops', $2, $3, $4, $5::jsonb)`,
      [
        input.actorUserId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );
  } catch (error) {
    if (required) throw error;
    log.warn({ err: error, action: input.action }, 'ops_action_audit write skipped');
  }
}

