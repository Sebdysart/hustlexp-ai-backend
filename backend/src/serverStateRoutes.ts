import type { Context } from 'hono';
import { z } from 'zod';
import { db } from './db.js';
import { logger } from './logger.js';
import { getAuthUser } from './serverRestAuth.js';
import type { HustleApp } from './serverTypes.js';

const uuidParam = z.string().uuid();
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const violationSchema = z.object({
  type: z.string().min(1).max(100),
  rule: z.string().min(1).max(200),
  component: z.string().min(1).max(200).optional(),
  context: z.record(z.string().max(128), z.string().max(512)).superRefine((value, context) => {
    if (Object.keys(value).length > 10) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 10,
        type: 'array',
        inclusive: true,
        message: 'context may have at most 10 keys',
      });
    }
  }).optional(),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']).default('ERROR'),
});

async function taskState(context: Context) {
  const user = await getAuthUser(context);
  if (!user) return context.json({ error: 'Unauthorized' }, 401);
  const taskId = context.req.param('taskId');
  if (!uuidParam.safeParse(taskId).success) return context.json({ error: 'Invalid taskId' }, 400);
  try {
    const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
      'SELECT state, poster_id, worker_id FROM tasks WHERE id = $1',
      [taskId],
    );
    const task = result.rows[0];
    if (!task || (task.poster_id !== user.id && task.worker_id !== user.id)) {
      return context.json({ error: 'Task not found' }, 404);
    }
    return context.json({ state: task.state });
  } catch (error) {
    logger.error({ err: error, taskId }, 'Failed to fetch task state');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

async function escrowState(context: Context) {
  const user = await getAuthUser(context);
  if (!user) return context.json({ error: 'Unauthorized' }, 401);
  const escrowId = context.req.param('escrowId');
  if (!uuidParam.safeParse(escrowId).success) {
    return context.json({ error: 'Invalid escrowId' }, 400);
  }
  try {
    const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
      `SELECT e.state, t.poster_id, t.worker_id
       FROM escrows e
       INNER JOIN tasks t ON t.id = e.task_id
       WHERE e.id = $1`,
      [escrowId],
    );
    const escrow = result.rows[0];
    if (!escrow || (escrow.poster_id !== user.id && escrow.worker_id !== user.id)) {
      return context.json({ error: 'Escrow not found' }, 404);
    }
    return context.json({ state: escrow.state });
  } catch (error) {
    logger.error({ err: error, escrowId }, 'Failed to fetch escrow state');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

async function uiViolation(context: Context) {
  const user = await getAuthUser(context);
  if (!user) return context.json({ error: 'Unauthorized' }, 401);
  const admin = await db.query<{ user_id: string }>(
    `SELECT user_id FROM admin_roles
     WHERE user_id = $1 AND role = ANY($2::text[])
     LIMIT 1`,
    [user.id, ['admin', 'founder']],
  );
  if (admin.rows.length === 0) return context.json({ error: 'Forbidden' }, 403);
  const parsed = violationSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
  }
  try {
    await db.query(
      `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
       VALUES ($1, 'UI_VIOLATION', NULL, $2, $3)`,
      [user.id, parsed.data.rule, JSON.stringify({
        violationType: parsed.data.type,
        component: parsed.data.component,
        context: parsed.data.context,
        severity: parsed.data.severity,
      })],
    );
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to log UI violation');
    return context.json({ error: 'Failed to log violation' }, 500);
  }
  return context.json({ success: true, loggedAt: new Date().toISOString() });
}

async function onboardingStatus(context: Context) {
  const userId = context.req.param('userId') ?? '';
  if (!userIdPattern.test(userId)) return context.json({ error: 'Invalid user ID' }, 400);
  const user = await getAuthUser(context);
  if (!user || user.id !== userId) return context.json({ error: 'Unauthorized' }, 401);
  try {
    const result = await db.query<{
      onboarding_completed_at: Date | null;
      default_mode: string;
      xp_first_celebration_shown_at: Date | null;
    }>(
      `SELECT onboarding_completed_at, default_mode, xp_first_celebration_shown_at
       FROM users WHERE id = $1`,
      [user.id],
    );
    if (result.rows.length === 0) return context.json({ error: 'User not found' }, 404);
    const data = result.rows[0];
    return context.json({
      onboardingComplete: data.onboarding_completed_at !== null,
      role: data.default_mode,
      xpFirstCelebrationShownAt: data.xp_first_celebration_shown_at?.toISOString() || null,
      hasCompletedFirstTask: data.xp_first_celebration_shown_at !== null,
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'Failed to fetch onboarding status');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

export function registerStateRoutes(app: HustleApp): void {
  app.get('/api/tasks/:taskId/state', taskState);
  app.get('/api/escrows/:escrowId/state', escrowState);
  app.post('/api/ui/violations', uiViolation);
  app.get('/api/users/:userId/onboarding-status', onboardingStatus);
}
