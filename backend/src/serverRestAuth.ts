import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { firebaseAuth } from './auth/firebase.js';
import { redis } from './cache/redis.js';
import { db } from './db.js';
import type { User } from './types.js';

export async function getAuthUser(context: Context): Promise<User | null> {
  const header = context.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
    if (await redis.get(`auth:revoked:${decoded.uid}`)) return null;
    const result = await db.query<User>(
      'SELECT id, firebase_uid, email, full_name, is_banned, account_status, default_mode, role, trust_tier, stripe_connect_id FROM users WHERE firebase_uid = $1',
      [decoded.uid],
    );
    const user = result.rows[0] || null;
    if (user && (
      user.is_banned
      || user.account_status === 'SUSPENDED'
      || user.account_status === 'DELETED'
    )) {
      throw new HTTPException(403, { message: 'Account suspended' });
    }
    return user;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return null;
  }
}
