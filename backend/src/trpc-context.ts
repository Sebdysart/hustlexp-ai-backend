import { firebaseAuth } from './auth/firebase.js';
import { ensureUserRowForFirebaseUid } from './auth/ensure-user.js';
import { authCache, authCacheKey, authCacheGet, authCacheSet } from './auth-cache.js';
import { redis } from './cache/redis.js';
import { db } from './db.js';
import { logger } from './logger.js';
import type { User } from './types.js';

const log = logger.child({ module: 'trpc-context' });
const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
const revokedKey = (uid: string) => `auth:revoked:${uid}`;

export interface Context extends Record<string, unknown> {
  user: User | null;
  firebaseUid: string | null;
  ip: string | null;
}

export interface AuthedContext extends Context {
  user: User;
}

function extractIp(req: Request): string | null {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim() || null;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((part) => part.trim()).filter(Boolean);
    return parts.at(-1) ?? null;
  }
  return req.headers.get('x-real-ip') || null;
}

function anonymousContext(req: Request): Context {
  return { user: null, firebaseUid: null, ip: extractIp(req) };
}

function isInactive(user: User): boolean {
  return Boolean(
    user.is_banned
    || user.account_status === 'SUSPENDED'
    || user.account_status === 'DELETED'
  );
}

async function applyAdminFlag(user: User): Promise<void> {
  const result = await db.query(
    'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
    [user.id, VALID_ADMIN_ROLES]
  );
  user.is_admin = result.rows.length > 0;
}

async function loadUser(firebaseUid: string): Promise<User | null> {
  const result = await db.query<User>('SELECT * FROM users WHERE firebase_uid = $1', [firebaseUid]);
  const user = result.rows[0] ?? await ensureUserRowForFirebaseUid(firebaseUid);
  if (user) await applyAdminFlag(user);
  return user;
}

async function cachedContext(token: string, req: Request): Promise<Context | null> {
  const cached = authCacheGet(token);
  if (!cached) return null;
  try {
    const revokedAt = await redis.get<string>(revokedKey(cached.firebaseUid));
    if (!revokedAt) {
      return { user: cached.user, firebaseUid: cached.firebaseUid, ip: extractIp(req) };
    }
    authCache.delete(authCacheKey(token));
    log.info({ uid: cached.firebaseUid }, 'tRPC cache entry invalidated by revocation marker');
  } catch (error) {
    log.warn({ err: error }, 'Redis unavailable for revocation check; verifying with Firebase');
  }
  return null;
}

function safeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g, '[REDACTED_TOKEN]');
}

async function verifiedContext(token: string, req: Request): Promise<Context> {
  const decoded = await firebaseAuth.verifyIdToken(token, true);
  const user = await loadUser(decoded.uid);
  if (user && !isInactive(user)) {
    authCacheSet(token, { user, firebaseUid: decoded.uid }, decoded.exp);
  }
  return { user, firebaseUid: decoded.uid, ip: extractIp(req) };
}

export async function createContext(opts: { req: Request; resHeaders: Headers }): Promise<Context> {
  const authHeader = opts.req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return anonymousContext(opts.req);
  const token = authHeader.slice(7);
  const cached = await cachedContext(token, opts.req);
  if (cached) return cached;
  try {
    return await verifiedContext(token, opts.req);
  } catch (error) {
    log.error({ err: safeAuthError(error) }, 'Firebase token verification failed');
    return anonymousContext(opts.req);
  }
}
