/**
 * N4 Feed Eligibility Invariant Tests
 *
 * These tests execute the production FeedQueryService against PostgreSQL.
 * A copied or simplified SQL query is not acceptable evidence for this gate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { CapabilityProfile } from '../../src/services/CapabilityProfileService';
import { queryFeed } from '../../src/services/FeedQueryService';
import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService';
import {
  cleanupTestData,
  createTestEscrow,
  createTestPool,
  createTestTask,
  createTestUser,
  hasDb,
} from '../setup';

let pool: pg.Pool;

type WorkerOptions = {
  profile?: boolean;
  trustTier?: number;
  riskClearance?: string[];
  isMinor?: boolean;
  isBanned?: boolean;
  trustHold?: boolean;
  trustHoldUntil?: Date | null;
  payoutsEnabled?: boolean;
};

function profileFor(userId: string, options: WorkerOptions = {}): CapabilityProfile {
  return {
    userId,
    trustTier: options.trustTier ?? 2,
    riskClearance: options.riskClearance ?? ['low', 'medium'],
    locationState: 'WA',
    locationCity: 'Seattle',
    insuranceValid: false,
    insuranceExpiresAt: null,
    backgroundCheckValid: false,
    backgroundCheckExpiresAt: null,
    verifiedTrades: [],
    updatedAt: new Date().toISOString(),
  };
}

async function createWorker(options: WorkerOptions = {}): Promise<{
  id: string;
  profile: CapabilityProfile;
}> {
  const { id } = await createTestUser(pool);
  await pool.query(
    `UPDATE users
     SET default_mode = 'worker',
         trust_tier = $2,
         date_of_birth = DATE '1990-01-01',
         is_minor = $3,
         is_banned = $4,
         trust_hold = $5,
         trust_hold_until = $6,
         account_status = 'ACTIVE',
         is_verified = TRUE,
         phone = '+1206' || substr(replace(id::text, '-', ''), 1, 7),
         stripe_connect_id = $7,
         payouts_enabled = $8,
         location_state = 'WA',
         location_city = 'Seattle'
     WHERE id = $1`,
    [
      id,
      options.trustTier ?? 2,
      options.isMinor ?? false,
      options.isBanned ?? false,
      options.trustHold ?? false,
      options.trustHoldUntil ?? null,
      `acct_test_${id.replaceAll('-', '')}`,
      options.payoutsEnabled ?? true,
    ],
  );
  const profile = profileFor(id, options);
  if (options.profile !== false) {
    await pool.query(
      `INSERT INTO capability_profiles (
         user_id, trust_tier, risk_clearance, location_state, location_city,
         insurance_valid, background_check_valid, updated_at
       ) VALUES ($1, $2, $3, 'WA', 'Seattle', FALSE, FALSE, NOW())`,
      [id, profile.trustTier, profile.riskClearance],
    );
  }
  return { id, profile };
}

async function createPoster(): Promise<string> {
  const { id } = await createTestUser(pool);
  await pool.query(
    `UPDATE users SET default_mode = 'poster', is_minor = FALSE, date_of_birth = DATE '1990-01-01'
     WHERE id = $1`,
    [id],
  );
  return id;
}

async function createFundedTask(posterId: string, state = 'OPEN', trustTierRequired = 1): Promise<string> {
  const task = await createTestTask(pool, { posterId, state, trustTierRequired });
  await createTestEscrow(pool, task.id, 'FUNDED');
  return task.id;
}

function loadFeed(userId: string, profile: CapabilityProfile) {
  return queryFeed({ userId, capabilityProfile: profile, pagination: { limit: 50 } });
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
});

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (pool) await cleanupTestData(pool);
});

describe.skipIf(!hasDb)('INV-N4 production feed SQL authority', () => {
  it('returns a funded, policy-bound, eligible OPEN task as immediately actionable', async () => {
    const worker = await createWorker();
    const taskId = await createFundedTask(await createPoster());

    const feed = await loadFeed(worker.id, worker.profile);
    const task = feed.tasks.find(candidate => candidate.id === taskId);

    expect(task).toMatchObject({
      id: taskId,
      payout: { cents: 4000, currency: 'usd' },
      riskLevel: 'low',
      eligibility: { eligible: true, code: 'HX200' },
    });
    expect(feed.filters).toEqual({ applied: ['database_eligibility'], excluded: 0 });
  });

  it('excludes terminal and unfunded tasks before application mapping', async () => {
    const worker = await createWorker();
    const posterId = await createPoster();
    const completedId = await createFundedTask(posterId, 'COMPLETED');
    const unfunded = await createTestTask(pool, { posterId });

    const ids = (await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id);
    expect(ids).not.toContain(completedId);
    expect(ids).not.toContain(unfunded.id);
  });

  it('fails closed when the authoritative capability profile is missing', async () => {
    const worker = await createWorker({ profile: false });
    const taskId = await createFundedTask(await createPoster());

    const ids = (await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id);
    expect(ids).not.toContain(taskId);
  });

  it.each([
    ['minor account', { isMinor: true }],
    ['terminal ban', { isBanned: true }],
    ['active trust hold', { trustHold: true, trustHoldUntil: new Date(Date.now() + 60_000) }],
    ['missing payout readiness', { payoutsEnabled: false }],
  ] satisfies Array<[string, WorkerOptions]>)('excludes %s', async (_label, options) => {
    const worker = await createWorker(options);
    const taskId = await createFundedTask(await createPoster());

    const ids = (await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id);
    expect(ids).not.toContain(taskId);
  });

  it('treats an expired trust hold as inactive', async () => {
    const worker = await createWorker({
      trustHold: true,
      trustHoldUntil: new Date(Date.now() - 60_000),
    });
    const taskId = await createFundedTask(await createPoster());

    const ids = (await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id);
    expect(ids).toContain(taskId);
  });

  it('uses database trust state even when caller profile data attempts to widen access', async () => {
    const worker = await createWorker({ trustTier: 1, riskClearance: ['low'] });
    const taskId = await createFundedTask(await createPoster(), 'OPEN', 3);
    const forgedProfile: CapabilityProfile = {
      ...worker.profile,
      trustTier: 4,
      riskClearance: ['low', 'medium', 'high', 'critical'],
    };

    const ids = (await loadFeed(worker.id, forgedProfile)).tasks.map(task => task.id);
    expect(ids).not.toContain(taskId);
  });

  it('suppresses active applications and restores withdrawn work for legitimate reapplication', async () => {
    const worker = await createWorker();
    const taskId = await createFundedTask(await createPoster());
    const application = await pool.query<{ id: string }>(
      `INSERT INTO task_applications (task_id, hustler_id, message)
       VALUES ($1, $2, 'I can do this work') RETURNING id`,
      [taskId, worker.id],
    );

    expect((await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id)).not.toContain(taskId);
    await pool.query(
      `UPDATE task_applications SET status = 'withdrawn', updated_at = NOW() WHERE id = $1`,
      [application.rows[0].id],
    );
    expect((await loadFeed(worker.id, worker.profile)).tasks.map(task => task.id)).toContain(taskId);
  });

  it('rejects a capability profile belonging to a different worker before querying', async () => {
    const worker = await createWorker();
    const other = await createWorker();
    await expect(loadFeed(worker.id, other.profile)).rejects.toThrow(
      'Capability profile does not belong to the requested user',
    );
  });

  it('keeps the primary personalized and search feeds on the same actionable SQL authority', async () => {
    const worker = await createWorker();
    const taskId = await createFundedTask(await createPoster());
    const personalized = await TaskDiscoveryService.getFeed(worker.id, {}, 50, 0);
    expect(personalized.success).toBe(true);
    if (!personalized.success) throw new Error(personalized.error.message);
    const feedItem = personalized.data.find(item => item.task.id === taskId);
    expect(feedItem?.offer_decision).toMatchObject({
      decisionReady: true,
      blockingReasons: [],
      economics: { payoutCents: 4000, netPayoutCents: 3900 },
      logistics: { estimatedDurationMinutes: 60, area: 'Seattle, WA' },
    });

    const search = await TaskDiscoveryService.search(worker.id, { query: 'Test Task' }, 50, 0);
    expect(search.success).toBe(true);
    if (!search.success) throw new Error(search.error.message);
    expect(search.data.map(item => item.task.id)).toContain(taskId);
  });
});
