/**
 * outbox-worker-lock.test.ts
 *
 * W47-1 FIX: Verifies that the Redis distributed lock release in startOutboxWorker
 * uses the @upstash/redis array-based eval signature:
 *   eval(script, keys: string[], args: string[])
 * NOT the ioredis positional signature:
 *   eval(script, numkeys, key, arg)  ← was silently broken
 *
 * The test inspects the source of startOutboxWorker to assert that the correct
 * array-based call form is present in the code, since we cannot easily invoke
 * startOutboxWorker (it starts setInterval loops) in unit tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKER_PATH = path.resolve(
  __dirname,
  '../../src/jobs/outbox-worker.ts'
);

describe('W47-1: Lua CAS-delete Redis eval signature', () => {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');

  it('uses array-based eval(script, [key], [arg]) — @upstash/redis API', () => {
    // The correct @upstash/redis signature passes keys and args as arrays.
    // Regex: eval(luaScript, [TRUST_TIER_LOCK_KEY], [LOCK_HOLDER_ID])
    expect(source).toMatch(
      /redisClient\.eval\(\s*luaScript\s*,\s*\[TRUST_TIER_LOCK_KEY\]\s*,\s*\[LOCK_HOLDER_ID\]\s*\)/
    );
  });

  it('does NOT use ioredis-style positional eval(script, 1, key, arg)', () => {
    // The broken form: eval(luaScript, 1, TRUST_TIER_LOCK_KEY, LOCK_HOLDER_ID)
    // passes a numeric numkeys as second arg — wrong for @upstash/redis.
    expect(source).not.toMatch(
      /redisClient\.eval\(\s*luaScript\s*,\s*1\s*,\s*TRUST_TIER_LOCK_KEY/
    );
  });
});
