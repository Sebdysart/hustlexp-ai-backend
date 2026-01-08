import { config } from '../config';

export type RedisClient = any;

export const CACHE_KEYS = {
  taskFeed: (userId: string) => `task:feed:${userId}`,
  leaderboardWeekly: () => 'leaderboard:weekly',
  leaderboardAllTime: () => 'leaderboard:alltime',
  userProfile: (userId: string) => `user:profile:${userId}`,
  aiCache: (hash: string) => `ai:cache:${hash}`,
  taskDetails: (taskId: string) => `task:details:${taskId}`,
  userStats: (userId: string) => `user:stats:${userId}`,
  sessionToken: (token: string) => `session:${token}`,
  rateLimit: (userId: string, action: string) => `ratelimit:${userId}:${action}`,
} as const;

export const CACHE_TTL = {
  taskFeed: 5 * 60,
  leaderboard: 60 * 60,
  userProfile: 15 * 60,
  aiCache: 24 * 60 * 60,
  taskDetails: 10 * 60,
  userStats: 30 * 60,
  sessionToken: 7 * 24 * 60 * 60,
  rateLimit: 60,
} as const;

export async function createRedisClient(): Promise<RedisClient> {
  console.log('🔄 Redis client stub - real implementation pending');
  console.log(`   Config: ${config.redis.url ? '✅ URL configured' : '❌ URL missing'}`);
  return null;
}

export async function get<T = string>(key: string): Promise<T | null> {
  console.log(`🔄 Redis GET stub: ${key}`);
  return null;
}

export async function set(
  key: string,
  value: string,
  ttl?: number
): Promise<void> {
  console.log(`🔄 Redis SET stub: ${key} (TTL: ${ttl || 'none'})`);
}

export async function del(key: string): Promise<void> {
  console.log(`🔄 Redis DEL stub: ${key}`);
}

export async function exists(key: string): Promise<boolean> {
  console.log(`🔄 Redis EXISTS stub: ${key}`);
  return false;
}

export async function incr(key: string): Promise<number> {
  console.log(`🔄 Redis INCR stub: ${key}`);
  return 1;
}

export async function expire(key: string, ttl: number): Promise<void> {
  console.log(`🔄 Redis EXPIRE stub: ${key} (TTL: ${ttl})`);
}

export async function zadd(
  key: string,
  score: number,
  member: string
): Promise<void> {
  console.log(`🔄 Redis ZADD stub: ${key}, score: ${score}`);
}

export async function zrange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  console.log(`🔄 Redis ZRANGE stub: ${key}, ${start}-${stop}`);
  return [];
}

export async function zrevrange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  console.log(`🔄 Redis ZREVRANGE stub: ${key}, ${start}-${stop}`);
  return [];
}

export async function checkRateLimit(
  userId: string,
  action: string,
  limit: number,
  window: number
): Promise<{ allowed: boolean; remaining: number }> {
  const key = CACHE_KEYS.rateLimit(userId, action);
  console.log(`🔄 Rate limit check stub: ${key} (limit: ${limit}/${window}s)`);
  return { allowed: true, remaining: limit };
}

export const redis = {
  get,
  set,
  del,
  exists,
  incr,
  expire,
  zadd,
  zrange,
  zrevrange,
  checkRateLimit,
};
