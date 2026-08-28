import type { Context } from 'hono';
import { z } from 'zod';
import { db } from './db.js';
import { logger } from './logger.js';
import { getAuthUser } from './serverRestAuth.js';
import type { HustleApp } from './serverTypes.js';

const uuidParam = z.string().uuid();
const timestampBody = z.object({ timestamp: z.string().datetime().optional() }).optional();
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorizedUser(context: Context) {
  const userId = context.req.param('userId') ?? '';
  if (!userIdPattern.test(userId)) return { error: context.json({ error: 'Invalid user ID' }, 400) };
  const user = await getAuthUser(context);
  if (!user || user.id !== userId) return { error: context.json({ error: 'Unauthorized' }, 401) };
  return { user };
}

async function requestTimestamp(context: Context): Promise<Date | null> {
  const body = await context.req.json().catch(() => ({}));
  const parsed = timestampBody.safeParse(body);
  return parsed.success && parsed.data?.timestamp ? new Date(parsed.data.timestamp) : null;
}

async function celebrationStatus(context: Context) {
  const auth = await authorizedUser(context);
  if ('error' in auth) return auth.error;
  try {
    const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
      'SELECT xp_first_celebration_shown_at FROM users WHERE id = $1',
      [auth.user.id],
    );
    return context.json({
      shouldShow: result.rows[0]?.xp_first_celebration_shown_at === null,
      xpFirstCelebrationShownAt:
        result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
    });
  } catch (error) {
    logger.error({ err: error, userId: auth.user.id }, 'Failed to fetch xp celebration status');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

async function markCelebrationShown(context: Context) {
  const auth = await authorizedUser(context);
  if ('error' in auth) return auth.error;
  const timestamp = await requestTimestamp(context);
  try {
    const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
      `UPDATE users
       SET xp_first_celebration_shown_at = COALESCE($2::timestamptz, NOW())
       WHERE id = $1 AND xp_first_celebration_shown_at IS NULL
       RETURNING xp_first_celebration_shown_at`,
      [auth.user.id, timestamp],
    );
    return context.json({
      success: true,
      xpFirstCelebrationShownAt:
        result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
    });
  } catch (error) {
    logger.error({ err: error, userId: auth.user.id }, 'Failed to mark xp celebration shown');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

function validBadgeId(context: Context): string | null {
  const badgeId = context.req.param('badgeId') ?? '';
  return uuidParam.safeParse(badgeId).success ? badgeId : null;
}

async function badgeStatus(context: Context) {
  const auth = await authorizedUser(context);
  if ('error' in auth) return auth.error;
  const badgeId = validBadgeId(context);
  if (!badgeId) return context.json({ error: 'Invalid badgeId' }, 400);
  try {
    const result = await db.query<{ animation_shown_at: Date | null }>(
      'SELECT animation_shown_at FROM badges WHERE id = $1 AND user_id = $2',
      [badgeId, auth.user.id],
    );
    if (result.rows.length === 0) return context.json({ error: 'Badge not found' }, 404);
    return context.json({
      shouldShow: result.rows[0].animation_shown_at === null,
      animationShownAt: result.rows[0].animation_shown_at?.toISOString() || null,
    });
  } catch (error) {
    logger.error({ err: error, badgeId, userId: auth.user.id }, 'Failed to fetch badge animation status');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

async function markBadgeShown(context: Context) {
  const auth = await authorizedUser(context);
  if ('error' in auth) return auth.error;
  const badgeId = validBadgeId(context);
  if (!badgeId) return context.json({ error: 'Invalid badgeId' }, 400);
  const timestamp = await requestTimestamp(context);
  try {
    const result = await db.query<{ animation_shown_at: Date | null }>(
      `UPDATE badges
       SET animation_shown_at = COALESCE($3::timestamptz, NOW())
       WHERE id = $1 AND user_id = $2 AND animation_shown_at IS NULL
       RETURNING animation_shown_at`,
      [badgeId, auth.user.id, timestamp],
    );
    return context.json({
      success: true,
      animationShownAt: result.rows[0]?.animation_shown_at?.toISOString() || null,
    });
  } catch (error) {
    logger.error({ err: error, badgeId, userId: auth.user.id }, 'Failed to mark badge animation shown');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

export function registerAnimationRoutes(app: HustleApp): void {
  app.get('/api/users/:userId/xp-celebration-status', celebrationStatus);
  app.post('/api/users/:userId/xp-celebration-shown', markCelebrationShown);
  app.get('/api/users/:userId/badges/:badgeId/animation-status', badgeStatus);
  app.post('/api/users/:userId/badges/:badgeId/animation-shown', markBadgeShown);
}
