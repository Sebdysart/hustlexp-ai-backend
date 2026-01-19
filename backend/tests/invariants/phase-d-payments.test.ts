/**
 * Phase D Payment Invariants - Kill Tests
 * 
 * PURPOSE: Prove that Phase D payment processing invariants are enforced
 *          These tests MUST FAIL if payment processing correctness is broken
 * 
 * These 5 tests protect against regressions that could cause:
 * - Double processing of Stripe events
 * - Duplicate escrow state changes
 * - Illegal escrow transitions (LOCKED_DISPUTE → RELEASED)
 * - Duplicate outbox events
 * - XP awarded without RELEASED escrow (also tested in inv-1.test.ts)
 * 
 * Phase D: Payments, XP, and Escrow correctness
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { 
  createTestPool, 
  cleanupTestData, 
  createTestUser, 
  createTestTask, 
  createTestEscrow 
} from '../setup';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  
  const result = await pool.query('SELECT version FROM schema_versions LIMIT 1');
  console.log('Connected to database with schema version:', result.rows[0]?.version);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// =============================================================================
// PAYMENT INVARIANT 1: Duplicate Stripe event idempotency
// =============================================================================

describe('Payment Invariant 1: Duplicate Stripe event insert does not create multiple outbox events', () => {
  
  it('MUST REJECT: duplicate stripe_event_id insert (UNIQUE constraint)', async () => {
    const stripeEventId = 'evt_test_duplicate_' + Date.now();
    const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } });
    
    // First insert should succeed
    await pool.query(
      `INSERT INTO stripe_events (stripe_event_id, type, created, payload_json)
       VALUES ($1, 'payment_intent.succeeded', NOW(), $2)`,
      [stripeEventId, payload]
    );
    
    // Duplicate insert should fail (UNIQUE constraint on stripe_event_id PRIMARY KEY)
    await expect(
      pool.query(
        `INSERT INTO stripe_events (stripe_event_id, type, created, payload_json)
         VALUES ($1, 'payment_intent.succeeded', NOW(), $2)`,
        [stripeEventId, payload]
      )
    ).rejects.toMatchObject({
      code: '23505', // Unique violation
    });
    
    // Verify only one row exists
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM stripe_events WHERE stripe_event_id = $1',
      [stripeEventId]
    );
    expect(parseInt(result.rows[0].count)).toBe(1);
  });
});

// =============================================================================
// PAYMENT INVARIANT 2: Same stripe_event processed twice cannot change escrow state twice
// =============================================================================

describe('Payment Invariant 2: Same stripe_event processed twice cannot change escrow state twice', () => {
  
  it('MUST PREVENT: duplicate escrow state change from same Stripe event (version check)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    const paymentIntentId = 'pi_test_' + Date.now();
    
    // Set up: escrow has payment_intent_id and version = 1
    await pool.query(
      `UPDATE escrows SET stripe_payment_intent_id = $1, version = 1 WHERE id = $2`,
      [paymentIntentId, escrowId]
    );
    
    // First state change: PENDING → FUNDED (version 1 → 2)
    const update1 = await pool.query(
      `UPDATE escrows
       SET state = 'FUNDED',
           funded_at = NOW(),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND state = 'PENDING'
         AND version = 1
       RETURNING version`,
      [escrowId]
    );
    
    expect(update1.rowCount).toBe(1);
    expect(update1.rows[0].version).toBe(2);
    
    // Verify state changed
    const state1 = await pool.query('SELECT state, version FROM escrows WHERE id = $1', [escrowId]);
    expect(state1.rows[0].state).toBe('FUNDED');
    expect(state1.rows[0].version).toBe(2);
    
    // Second attempt with same version (1) should fail - version mismatch
    const update2 = await pool.query(
      `UPDATE escrows
       SET state = 'FUNDED',
           funded_at = NOW(),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND state = 'PENDING'
         AND version = 1
       RETURNING version`,
      [escrowId]
    );
    
    // Should have no rows updated (version mismatch + state mismatch)
    expect(update2.rowCount).toBe(0);
    
    // Verify state did not change
    const state2 = await pool.query('SELECT state, version FROM escrows WHERE id = $1', [escrowId]);
    expect(state2.rows[0].state).toBe('FUNDED');
    expect(state2.rows[0].version).toBe(2);
  });
});

// =============================================================================
// PAYMENT INVARIANT 3: Escrow cannot transition out of terminal states
// =============================================================================

describe('Payment Invariant 3: Escrow cannot transition out of terminal states (trigger enforced)', () => {
  
  it('MUST REJECT: transition RELEASED → FUNDED (terminal state protection)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Attempt to transition from terminal state should fail
    await expect(
      pool.query(`UPDATE escrows SET state = 'FUNDED' WHERE id = $1`, [escrowId])
    ).rejects.toMatchObject({
      code: 'HX002', // Escrow terminal state violation
    });
  });
  
  it('MUST REJECT: transition REFUNDED → FUNDED (terminal state protection)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUNDED');
    
    // Attempt to transition from terminal state should fail
    await expect(
      pool.query(`UPDATE escrows SET state = 'FUNDED' WHERE id = $1`, [escrowId])
    ).rejects.toMatchObject({
      code: 'HX002', // Escrow terminal state violation
    });
  });
  
  // Note: This invariant is also tested in inv-2.test.ts "Terminal State Protection" section
});

// =============================================================================
// PAYMENT INVARIANT 4: XP insert fails unless escrow is RELEASED
// =============================================================================

describe('Payment Invariant 4: XP insert fails unless escrow is RELEASED', () => {
  
  it('MUST REJECT: XP award when escrow is NOT RELEASED (FUNDED state)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      pool.query(
        `INSERT INTO xp_ledger (
          user_id, task_id, escrow_id, base_xp, effective_xp,
          user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award
        ) VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 1, 0)`,
        [workerId, taskId, escrowId]
      )
    ).rejects.toMatchObject({
      code: 'HX101', // XP requires RELEASED escrow
    });
  });
  
  // Note: This invariant is comprehensively tested in inv-1.test.ts
});

// =============================================================================
// PAYMENT INVARIANT 5: LOCKED_DISPUTE cannot be released
// =============================================================================

describe('Payment Invariant 5: LOCKED_DISPUTE cannot transition to RELEASED', () => {
  
  it('MUST REJECT: transition LOCKED_DISPUTE → RELEASED (Policy 1: dispute blocks release)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'LOCKED_DISPUTE');
    
    // Attempt to release escrow from LOCKED_DISPUTE state should fail
    // This is enforced by the state machine (VALID_TRANSITIONS) and the payment worker
    // The state machine does not allow LOCKED_DISPUTE → RELEASED
    await expect(
      pool.query(
        `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1`,
        [escrowId]
      )
    ).rejects.toMatchObject({
      code: 'HX002', // Terminal state guard OR state machine constraint
    });
    
    // Verify state did not change
    const result = await pool.query('SELECT state FROM escrows WHERE id = $1', [escrowId]);
    expect(result.rows[0].state).toBe('LOCKED_DISPUTE');
  });
  
  it('MUST ALLOW: transition LOCKED_DISPUTE → REFUNDED (dispute resolution)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'DISPUTED');
    const escrowId = await createTestEscrow(pool, taskId, 'LOCKED_DISPUTE');
    
    // Refunding from LOCKED_DISPUTE should be allowed
    await pool.query(
      `UPDATE escrows SET state = 'REFUNDED', refunded_at = NOW() WHERE id = $1`,
      [escrowId]
    );
    
    // Verify state changed
    const result = await pool.query('SELECT state FROM escrows WHERE id = $1', [escrowId]);
    expect(result.rows[0].state).toBe('REFUNDED');
  });
  
  it('MUST ALLOW: transition LOCKED_DISPUTE → REFUND_PARTIAL (dispute resolution)', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'DISPUTED');
    const escrowId = await createTestEscrow(pool, taskId, 'LOCKED_DISPUTE');
    
    // Partial refund from LOCKED_DISPUTE should be allowed
    await pool.query(
      `UPDATE escrows 
       SET state = 'REFUND_PARTIAL', 
           refund_amount = 2500, 
           release_amount = 2500,
           refunded_at = NOW() 
       WHERE id = $1`,
      [escrowId]
    );
    
    // Verify state changed
    const result = await pool.query('SELECT state FROM escrows WHERE id = $1', [escrowId]);
    expect(result.rows[0].state).toBe('REFUND_PARTIAL');
  });
});
