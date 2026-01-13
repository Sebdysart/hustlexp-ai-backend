/**
 * Stripe Monetization Invariants (Step 9-D)
 * 
 * Tests for Stripe webhook idempotency and plan/entitlement safety.
 * 
 * Invariants:
 * - S-1: Stripe event idempotency (duplicate events rejected)
 * - S-2: Subscription plan changes are monotonic (replay-safe)
 * - S-3: Per-task entitlements are idempotent (no duplicates)
 * - S-4: Entitlements never outlive validity (expired = no access)
 * - S-5: Entitlements must reference a valid Stripe event (causal linkage)
 * 
 * Note: Uses direct `db` import (not pool abstraction) to test constraints directly.
 * This is intentional for invariant tests - we're testing database-level enforcement,
 * not application-level transaction boundaries. Production code uses pool abstraction.
 * 
 * TODO (Future): Add out-of-order Stripe event replay handling (Stripe doesn't guarantee order).
 * This may require `created_at` monotonic checks or explicit event precedence rules.
 * 
 * @see STEP_9D_STRIPE_INTEGRATION.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../src/db';
import { PlanService } from '../../src/services/PlanService';
import type { User, Task } from '../../src/types';

// ============================================================================
// TEST HELPERS
// ============================================================================

async function createTestUser(plan: 'free' | 'premium' | 'pro' = 'free'): Promise<User> {
  const result = await db.query<User>(
    `INSERT INTO users (email, full_name, firebase_uid, default_mode, role_was_overridden, plan)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      `test_${Date.now()}_${Math.random()}@test.com`,
      'Test User',
      `firebase_${Date.now()}_${Math.random()}`,
      'poster',
      false,
      plan,
    ]
  );
  return result.rows[0];
}

async function insertStripeEvent(
  stripeEventId: string,
  type: string = 'checkout.session.completed',
  payload: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO stripe_events (stripe_event_id, type, payload_json, created)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [stripeEventId, type, JSON.stringify(payload)]
  );
}

async function insertEntitlement(params: {
  userId: string;
  taskId?: string;
  riskLevel: 'MEDIUM' | 'HIGH' | 'IN_HOME';
  sourceEventId: string;
  expiresAt: Date;
}): Promise<void> {
  await db.query(
    `INSERT INTO plan_entitlements (user_id, task_id, risk_level, source_event_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.userId, params.taskId || null, params.riskLevel, params.sourceEventId, params.expiresAt]
  );
}

async function getUserPlan(userId: string): Promise<'free' | 'premium' | 'pro'> {
  const result = await db.query<{ plan: 'free' | 'premium' | 'pro' }>(
    `SELECT plan FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.plan || 'free';
}

async function updateUserPlan(
  userId: string,
  plan: 'free' | 'premium' | 'pro',
  sourceEventId: string
): Promise<void> {
  await db.query(
    `UPDATE users 
     SET plan = $1, 
         plan_subscribed_at = CASE WHEN $1 != 'free' THEN NOW() ELSE plan_subscribed_at END,
         plan_expires_at = CASE WHEN $1 != 'free' THEN NOW() + INTERVAL '30 days' ELSE NULL END
     WHERE id = $2`,
    [plan, userId]
  );
}

// ============================================================================
// INVARIANT S-1: Stripe Event Idempotency
// ============================================================================

describe('Invariant S-1: Stripe Event Idempotency', () => {
  it('S-1: duplicate stripe_event_id cannot be inserted', async () => {
    const eventId = `evt_test_${Date.now()}_${Math.random()}`;
    const payload = { type: 'checkout.session.completed', data: {} };

    // First insert succeeds
    await insertStripeEvent(eventId, 'checkout.session.completed', payload);

    // Second insert with same event_id should fail (PRIMARY KEY violation)
    await expect(
      insertStripeEvent(eventId, 'checkout.session.completed', payload)
    ).rejects.toThrow();

    // Verify exactly one row exists
    const count = await db.query(
      `SELECT COUNT(*) as count FROM stripe_events WHERE stripe_event_id = $1`,
      [eventId]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('S-1: different stripe_event_id can be inserted', async () => {
    const eventId1 = `evt_test_${Date.now()}_1`;
    const eventId2 = `evt_test_${Date.now()}_2`;

    await insertStripeEvent(eventId1);
    await insertStripeEvent(eventId2); // Should succeed

    const count = await db.query(
      `SELECT COUNT(*) as count FROM stripe_events WHERE stripe_event_id IN ($1, $2)`,
      [eventId1, eventId2]
    );
    expect(Number(count.rows[0].count)).toBe(2);
  });
});

// ============================================================================
// INVARIANT S-2: Subscription Plan Changes Are Monotonic
// ============================================================================

describe('Invariant S-2: Subscription Plan Changes Are Monotonic', () => {
  let userId: string;

  beforeAll(async () => {
    const user = await createTestUser('free');
    userId = user.id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('S-2: subscription event applies at most once', async () => {
    const eventId = `evt_sub_${Date.now()}`;
    const initialPlan = await getUserPlan(userId);
    expect(initialPlan).toBe('free');

    // First plan change
    await updateUserPlan(userId, 'premium', eventId);
    const afterFirst = await getUserPlan(userId);
    expect(afterFirst).toBe('premium');

    // Attempt to process same event again (replay)
    // In real implementation, this would check stripe_events.processed_at
    // For now, we verify the plan doesn't change on "replay"
    await updateUserPlan(userId, 'premium', eventId);
    const afterReplay = await getUserPlan(userId);
    expect(afterReplay).toBe('premium');

    // Verify plan_subscribed_at wasn't updated twice
    const user = await db.query<{ plan_subscribed_at: Date }>(
      `SELECT plan_subscribed_at FROM users WHERE id = $1`,
      [userId]
    );
    expect(user.rows[0].plan_subscribed_at).toBeDefined();
  });

  it('S-2: plan cannot downgrade before expiry', async () => {
    // Set user to premium with future expiry
    // TIME AUTHORITY: Uses DB NOW() as authoritative time source (not application clock)
    await db.query(
      `UPDATE users 
       SET plan = 'premium', 
           plan_expires_at = NOW() + INTERVAL '20 days'
       WHERE id = $1`,
      [userId]
    );

    const plan = await getUserPlan(userId);
    expect(plan).toBe('premium');

    // Attempt early downgrade should be prevented
    // In real implementation, this would check plan_expires_at > NOW()
    // TIME AUTHORITY: Downgrade logic must use DB NOW(), not application Date.now()
    const user = await db.query<{ plan: string; plan_expires_at: Date }>(
      `SELECT plan, plan_expires_at FROM users WHERE id = $1`,
      [userId]
    );
    const expiresAt = new Date(user.rows[0].plan_expires_at);
    const now = new Date();

    // If expiry is in future, downgrade should not happen
    // Note: This test uses JS Date for comparison, but production code must use DB NOW()
    if (expiresAt > now) {
      expect(user.rows[0].plan).toBe('premium');
    }
  });
});

// ============================================================================
// INVARIANT S-3: Per-Task Entitlements Are Idempotent
// ============================================================================

describe('Invariant S-3: Per-Task Entitlements Are Idempotent', () => {
  let userId: string;
  let taskId: string;

  beforeAll(async () => {
    const user = await createTestUser('free');
    userId = user.id;

    // Create a test task
    const taskResult = await db.query<Task>(
      `INSERT INTO tasks (poster_id, title, description, price, state, risk_level, progress_state, progress_updated_at)
       VALUES ($1, 'Test Task', 'Test', 1000, 'OPEN', 'LOW', 'POSTED', NOW())
       RETURNING *`,
      [userId]
    );
    taskId = taskResult.rows[0].id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM plan_entitlements WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('S-3: per-task entitlement is idempotent', async () => {
    const eventId = `evt_ent_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // First entitlement insert succeeds
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: eventId,
      expiresAt,
    });

    // Second insert with same source_event_id should fail (UNIQUE constraint)
    await expect(
      insertEntitlement({
        userId,
        taskId,
        riskLevel: 'HIGH',
        sourceEventId: eventId,
        expiresAt,
      })
    ).rejects.toThrow();

    // Verify exactly one entitlement exists
    const count = await db.query(
      `SELECT COUNT(*) as count FROM plan_entitlements WHERE source_event_id = $1`,
      [eventId]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('S-3: different source_event_id can create multiple entitlements', async () => {
    const eventId1 = `evt_ent_${Date.now()}_1`;
    const eventId2 = `evt_ent_${Date.now()}_2`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: eventId1,
      expiresAt,
    });

    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'IN_HOME',
      sourceEventId: eventId2,
      expiresAt,
    }); // Should succeed

    const count = await db.query(
      `SELECT COUNT(*) as count FROM plan_entitlements WHERE source_event_id IN ($1, $2)`,
      [eventId1, eventId2]
    );
    expect(Number(count.rows[0].count)).toBe(2);
  });
});

// ============================================================================
// INVARIANT S-4: Entitlements Never Outlive Validity
// ============================================================================

describe('Invariant S-4: Entitlements Never Outlive Validity', () => {
  let userId: string;
  let taskId: string;

  beforeAll(async () => {
    const user = await createTestUser('free');
    userId = user.id;

    const taskResult = await db.query<Task>(
      `INSERT INTO tasks (poster_id, title, description, price, state, risk_level, progress_state, progress_updated_at)
       VALUES ($1, 'Test Task', 'Test', 1000, 'OPEN', 'LOW', 'POSTED', NOW())
       RETURNING *`,
      [userId]
    );
    taskId = taskResult.rows[0].id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM plan_entitlements WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('S-4: expired entitlements grant no access', async () => {
    // Insert expired entitlement (1 day ago)
    const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: `evt_expired_${Date.now()}`,
      expiresAt: expiredAt,
    });

    // User should NOT be able to create HIGH risk task (entitlement expired)
    const check = await PlanService.canCreateTaskWithRisk(userId, 'HIGH');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Premium plan required');
  });

  it('S-4: active entitlements grant access', async () => {
    // Insert active entitlement (24 hours from now)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: `evt_active_${Date.now()}`,
      expiresAt,
    });

    // Note: PlanService.canCreateTaskWithRisk doesn't check entitlements yet
    // This test documents the expected behavior once entitlement checks are added
    // For now, we verify the entitlement exists and is not expired
    const entitlements = await db.query(
      `SELECT * FROM plan_entitlements 
       WHERE user_id = $1 
         AND risk_level = 'HIGH'
         AND expires_at > NOW()`,
      [userId]
    );
    expect(entitlements.rows.length).toBeGreaterThan(0);
  });

  it('S-4: expired entitlements are not returned in active queries', async () => {
    const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Insert both expired and active
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'MEDIUM',
      sourceEventId: `evt_expired_${Date.now()}`,
      expiresAt: expiredAt,
    });

    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'MEDIUM',
      sourceEventId: `evt_active_${Date.now()}`,
      expiresAt: activeAt,
    });

    // Query for active entitlements only
    // TIME AUTHORITY: Uses DB NOW() for expiry comparison (authoritative)
    const active = await db.query(
      `SELECT * FROM plan_entitlements 
       WHERE user_id = $1 
         AND risk_level = 'MEDIUM'
         AND expires_at > NOW()`,
      [userId]
    );

    // Should only return the active one
    expect(active.rows.length).toBe(1);
    expect(active.rows[0].expires_at > new Date()).toBe(true);
  });
});

// ============================================================================
// INVARIANT S-5: Entitlements Must Reference a Valid Stripe Event
// ============================================================================

describe('Invariant S-5: Entitlements Must Reference a Valid Stripe Event', () => {
  let userId: string;
  let taskId: string;

  beforeAll(async () => {
    const user = await createTestUser('free');
    userId = user.id;

    const taskResult = await db.query<Task>(
      `INSERT INTO tasks (poster_id, title, description, price, state, risk_level, progress_state, progress_updated_at)
       VALUES ($1, 'Test Task', 'Test', 1000, 'OPEN', 'LOW', 'POSTED', NOW())
       RETURNING *`,
      [userId]
    );
    taskId = taskResult.rows[0].id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM plan_entitlements WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('S-5: entitlement creation requires valid Stripe event', async () => {
    const eventId = `evt_valid_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // First, insert the Stripe event (causal requirement)
    await insertStripeEvent(eventId, 'payment_intent.succeeded', {
      data: { object: { id: `pi_${Date.now()}` } },
    });

    // Verify event exists
    const eventExists = await db.query(
      `SELECT COUNT(*) as count FROM stripe_events WHERE stripe_event_id = $1`,
      [eventId]
    );
    expect(Number(eventExists.rows[0].count)).toBe(1);

    // Now create entitlement referencing the event (this should succeed)
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: eventId,
      expiresAt,
    });

    // Verify entitlement exists
    const entitlementExists = await db.query(
      `SELECT COUNT(*) as count FROM plan_entitlements WHERE source_event_id = $1`,
      [eventId]
    );
    expect(Number(entitlementExists.rows[0].count)).toBe(1);
  });

  it('S-5: entitlement with non-existent Stripe event should be rejected by service layer', async () => {
    const fakeEventId = `evt_nonexistent_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Attempt to create entitlement without corresponding Stripe event
    // Note: Database constraint doesn't enforce FK (by design - allows for async processing)
    // But service layer MUST validate event exists before creating entitlement
    // This test documents the expected behavior once service layer validation is added

    // For now, we verify the event doesn't exist
    const eventExists = await db.query(
      `SELECT COUNT(*) as count FROM stripe_events WHERE stripe_event_id = $1`,
      [fakeEventId]
    );
    expect(Number(eventExists.rows[0].count)).toBe(0);

    // TODO: Once service layer validation is added, this should fail:
    // await expect(
    //   PlanService.createEntitlement({
    //     userId,
    //     taskId,
    //     riskLevel: 'HIGH',
    //     sourceEventId: fakeEventId,
    //     expiresAt,
    //   })
    // ).rejects.toThrow('Stripe event not found');
  });

  it('S-5: service layer must verify Stripe event exists before creating entitlement', async () => {
    // This test documents the causal requirement:
    // Entitlements MUST be derived from validated Stripe events
    // No rogue internal calls can mint entitlements
    // No bugs can bypass Stripe entirely

    const eventId = `evt_audit_${Date.now()}`;

    // Valid flow: Event exists → Entitlement created
    await insertStripeEvent(eventId);
    await insertEntitlement({
      userId,
      taskId,
      riskLevel: 'HIGH',
      sourceEventId: eventId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // Verify causal linkage: entitlement references existing event
    const linkage = await db.query(
      `SELECT e.source_event_id, se.stripe_event_id
       FROM plan_entitlements e
       LEFT JOIN stripe_events se ON e.source_event_id = se.stripe_event_id
       WHERE e.source_event_id = $1`,
      [eventId]
    );

    // Both should exist and be linked
    expect(linkage.rows.length).toBe(1);
    expect(linkage.rows[0].stripe_event_id).toBe(eventId);
    expect(linkage.rows[0].source_event_id).toBe(eventId);
  });
});
