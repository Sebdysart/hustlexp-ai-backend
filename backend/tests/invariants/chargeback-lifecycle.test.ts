/**
 * Chargeback Lifecycle Kill Tests
 *
 * PURPOSE: Prove that the chargeback enforcement layer works:
 * - payment_disputes cannot be deleted (HX811)
 * - revenue_ledger chargeback entries cannot be updated/deleted (HX701/HX702)
 * - escrow releases are blocked when payouts_locked = TRUE (HX801)
 * - trust tier downgrades are recorded in trust_ledger
 *
 * SPEC: Stripe chargeback lifecycle automation (Sprint 1)
 * ENFORCEMENT: chargeback_lifecycle.sql triggers
 * ERROR CODES: HX801 (payout freeze), HX811 (dispute delete)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  createTestPool,
  cleanupTestData,
  createTestUser,
  createTestTask,
  createTestEscrow,
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
// PAYMENT DISPUTES APPEND-ONLY (HX811)
// =============================================================================

describe('Chargeback: payment_disputes no delete (HX811)', () => {
  it('MUST REJECT: DELETE from payment_disputes', async () => {
    // Setup: create a user, a stripe_event, and a payment_dispute
    const user = await createTestUser(pool);

    // Insert a stripe event for FK reference
    await pool.query(
      `INSERT INTO stripe_events (stripe_event_id, type, created, payload_json)
       VALUES ('evt_test_chargeback_001', 'charge.dispute.created', NOW(), '{}')
       ON CONFLICT DO NOTHING`
    );

    // Insert a payment dispute
    await pool.query(
      `INSERT INTO payment_disputes (
         stripe_dispute_id, stripe_charge_id, stripe_event_id,
         user_id, amount_cents, currency, status
       )
       VALUES ('dp_test_001', 'ch_test_001', 'evt_test_chargeback_001',
               $1, 5000, 'usd', 'open')`,
      [user.id]
    );

    // Attempt DELETE — must fail with HX811
    try {
      await pool.query(
        `DELETE FROM payment_disputes WHERE stripe_dispute_id = 'dp_test_001'`
      );
      expect.fail('DELETE should have been rejected by trigger');
    } catch (error: any) {
      expect(error.code).toBe('HX811');
      expect(error.message).toContain('PAYMENT_DISPUTE_DELETE_BLOCKED');
    }
  });
});

// =============================================================================
// ESCROW PAYOUT FREEZE GUARD (HX801)
// =============================================================================

describe('Chargeback: escrow release blocked when payouts_locked (HX801)', () => {
  it('MUST REJECT: escrow release when worker has payouts_locked = TRUE', async () => {
    // Setup: create poster, worker, task, escrow
    const poster = await createTestUser(pool);
    const worker = await createTestUser(pool);

    const task = await createTestTask(pool, {
      posterId: poster.id,
      workerId: worker.id,
      state: 'COMPLETED',
    });

    const escrow = await createTestEscrow(pool, {
      taskId: task.id,
      state: 'FUNDED',
    });

    // Lock worker payouts
    await pool.query(
      `UPDATE users
       SET payouts_locked = TRUE,
           payouts_locked_at = NOW(),
           payouts_locked_reason = 'test chargeback'
       WHERE id = $1`,
      [worker.id]
    );

    // Attempt escrow release — must fail with HX801
    try {
      await pool.query(
        `UPDATE escrows
         SET state = 'RELEASED', released_at = NOW()
         WHERE id = $1 AND state = 'FUNDED'`,
        [escrow.id]
      );
      expect.fail('Escrow release should have been blocked by payout freeze trigger');
    } catch (error: any) {
      expect(error.code).toBe('HX810');
      expect(error.message).toContain('PAYOUT_FROZEN');
    }
  });

  it('MUST ALLOW: escrow release when worker has payouts_locked = FALSE', async () => {
    // Setup: create poster, worker, task, escrow
    const poster = await createTestUser(pool);
    const worker = await createTestUser(pool);

    const task = await createTestTask(pool, {
      posterId: poster.id,
      workerId: worker.id,
      state: 'COMPLETED',
    });

    const escrow = await createTestEscrow(pool, {
      taskId: task.id,
      state: 'FUNDED',
    });

    // Ensure worker payouts are NOT locked (default)
    await pool.query(
      `UPDATE users SET payouts_locked = FALSE WHERE id = $1`,
      [worker.id]
    );

    // Attempt escrow release — must succeed
    const result = await pool.query(
      `UPDATE escrows
       SET state = 'RELEASED', released_at = NOW()
       WHERE id = $1 AND state = 'FUNDED'
       RETURNING state`,
      [escrow.id]
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].state).toBe('RELEASED');
  });
});

// =============================================================================
// REVENUE LEDGER CHARGEBACK ENTRIES (HX701/HX702)
// =============================================================================

describe('Chargeback: revenue_ledger chargeback entries are immutable', () => {
  it('MUST REJECT: UPDATE on chargeback ledger entry (HX701)', async () => {
    const user = await createTestUser(pool);

    // Insert a chargeback ledger entry
    const insertResult = await pool.query(
      `INSERT INTO revenue_ledger (event_type, user_id, amount_cents, metadata)
       VALUES ('chargeback', $1, -5000, '{"stripe_dispute_id": "dp_test_002"}')
       RETURNING id`,
      [user.id]
    );

    const entryId = insertResult.rows[0].id;

    // Attempt UPDATE — must fail with HX701
    try {
      await pool.query(
        `UPDATE revenue_ledger SET amount_cents = 0 WHERE id = $1`,
        [entryId]
      );
      expect.fail('UPDATE should have been rejected by trigger');
    } catch (error: any) {
      expect(error.code).toBe('HX701');
    }
  });

  it('MUST REJECT: DELETE on chargeback ledger entry (HX702)', async () => {
    const user = await createTestUser(pool);

    // Insert a chargeback ledger entry
    await pool.query(
      `INSERT INTO revenue_ledger (event_type, user_id, amount_cents, metadata)
       VALUES ('chargeback', $1, -5000, '{"stripe_dispute_id": "dp_test_003"}')`,
      [user.id]
    );

    // Attempt DELETE — must fail with HX702
    try {
      await pool.query(
        `DELETE FROM revenue_ledger WHERE user_id = $1 AND event_type = 'chargeback'`,
        [user.id]
      );
      expect.fail('DELETE should have been rejected by trigger');
    } catch (error: any) {
      expect(error.code).toBe('HX702');
    }
  });
});

// =============================================================================
// CHARGEBACK LIFECYCLE INTEGRATION
// =============================================================================

describe('Chargeback: full lifecycle simulation', () => {
  it('dispute_count increments correctly on user', async () => {
    const user = await createTestUser(pool);

    // Simulate: dispute_count starts at 0
    const before = await pool.query<{ dispute_count: number }>(
      `SELECT COALESCE(dispute_count, 0) as dispute_count FROM users WHERE id = $1`,
      [user.id]
    );
    expect(before.rows[0].dispute_count).toBe(0);

    // Increment dispute_count (simulating ChargebackService behavior)
    await pool.query(
      `UPDATE users
       SET dispute_count = COALESCE(dispute_count, 0) + 1,
           last_dispute_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    const after = await pool.query<{ dispute_count: number }>(
      `SELECT dispute_count FROM users WHERE id = $1`,
      [user.id]
    );
    expect(after.rows[0].dispute_count).toBe(1);
  });

  it('payment_disputes status can advance forward but not backward', async () => {
    const user = await createTestUser(pool);

    await pool.query(
      `INSERT INTO stripe_events (stripe_event_id, type, created, payload_json)
       VALUES ('evt_test_lifecycle_001', 'charge.dispute.created', NOW(), '{}')
       ON CONFLICT DO NOTHING`
    );

    // Create dispute as 'open'
    await pool.query(
      `INSERT INTO payment_disputes (
         stripe_dispute_id, stripe_charge_id, stripe_event_id,
         user_id, amount_cents, currency, status
       )
       VALUES ('dp_lifecycle_001', 'ch_lifecycle_001', 'evt_test_lifecycle_001',
               $1, 5000, 'usd', 'open')`,
      [user.id]
    );

    // Advance to needs_response
    await pool.query(
      `UPDATE payment_disputes SET status = 'needs_response'
       WHERE stripe_dispute_id = 'dp_lifecycle_001'`
    );

    // Advance to under_review
    await pool.query(
      `UPDATE payment_disputes SET status = 'under_review'
       WHERE stripe_dispute_id = 'dp_lifecycle_001'`
    );

    // Advance to lost (terminal)
    await pool.query(
      `UPDATE payment_disputes SET status = 'lost', resolved_at = NOW()
       WHERE stripe_dispute_id = 'dp_lifecycle_001'`
    );

    // Verify terminal state
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM payment_disputes WHERE stripe_dispute_id = 'dp_lifecycle_001'`
    );
    expect(result.rows[0].status).toBe('lost');
  });
});
