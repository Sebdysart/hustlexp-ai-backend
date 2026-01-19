/**
 * Evil Test A: SPLIT with transfer failure
 * 
 * This script tests that SPLIT resolution does NOT terminalize escrow
 * when transfer creation fails.
 * 
 * Steps:
 * 1. Create valid SPLIT resolution scenario (task, escrow, dispute)
 * 2. Resolve dispute with SPLIT
 * 3. Run with HX_FAIL_STRIPE_TRANSFER=1 (transfer fails)
 * 4. Verify escrow stays LOCKED_DISPUTE (not REFUND_PARTIAL)
 * 5. Remove flag, retry, verify escrow becomes REFUND_PARTIAL
 * 
 * Run with:
 *   HX_STRIPE_STUB=1 DATABASE_URL=... REDIS_URL=... node scripts/test-evil-a-split-transfer-fail.mjs
 * 
 * Prerequisites:
 * - Redis running
 * - Workers running (npm run dev:workers)
 * - DATABASE_URL set
 */

import pg from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import { DisputeService } from '../backend/src/services/DisputeService.js';

const { Pool } = pg;

// ============================================================================
// CONFIGURATION
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || 'redis://127.0.0.1:6379';

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is required');
  process.exit(1);
}

if (process.env.HX_STRIPE_STUB !== '1') {
  console.error('❌ HX_STRIPE_STUB=1 is required (stub Stripe calls)');
  process.exit(1);
}

// ============================================================================
// HELPERS
// ============================================================================

function printSnapshot(label, escrow) {
  console.log(`\n📸 ${label}:`);
  console.log(`   state: ${escrow.state}`);
  console.log(`   stripe_refund_id: ${escrow.stripe_refund_id || 'NULL'}`);
  console.log(`   stripe_transfer_id: ${escrow.stripe_transfer_id || 'NULL'}`);
  console.log(`   refund_amount: ${escrow.refund_amount || 0}`);
  console.log(`   release_amount: ${escrow.release_amount || 0}`);
  console.log(`   version: ${escrow.version}`);
}

async function getEscrowSnapshot(pool, escrowId) {
  const result = await pool.query(
    `SELECT state, stripe_refund_id, stripe_transfer_id, refund_amount, release_amount, version
     FROM escrows WHERE id = $1`,
    [escrowId]
  );
  return result.rows[0];
}

async function waitForJobCompletion(queue, jobId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return 'active';
}

// ============================================================================
// MAIN TEST
// ============================================================================

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const redis = new IORedis(REDIS_URL);
  const queue = new Queue('critical_payments', { connection: redis });

  try {
    console.log('🧪 Evil Test A: SPLIT with transfer failure\n');

    // Step 0: Preconditions check
    console.log('Step 0: Preconditions check...');
    await pool.query('SELECT 1');
    await redis.ping();
    console.log('✅ DB and Redis connected\n');

    // Step 1: Seed minimal records
    console.log('Step 1: Seeding test data...');
    const testId = randomUUID().slice(0, 8);

    // Create users
    const posterResult = await pool.query(
      `INSERT INTO users (email, full_name, default_mode)
       VALUES ($1, 'Test Poster', 'poster')
       RETURNING id`,
      [`evil-test-a-${testId}-poster@test.com`]
    );
    const posterId = posterResult.rows[0].id;

    const workerResult = await pool.query(
      `INSERT INTO users (email, full_name, default_mode, stripe_connect_id)
       VALUES ($1, 'Test Worker', 'worker', $2)
       RETURNING id`,
      [`evil-test-a-${testId}-worker@test.com`, 'acct_test_worker']
    );
    const workerId = workerResult.rows[0].id;

    // Create admin user (for dispute resolution)
    const adminResult = await pool.query(
      `INSERT INTO users (email, full_name, default_mode)
       VALUES ($1, 'Test Admin', 'poster')
       RETURNING id`,
      [`evil-test-a-${testId}-admin@test.com`]
    );
    const adminId = adminResult.rows[0].id;

    // Grant admin permission (skip admin_roles check for test - use direct SQL if table exists)
    try {
      await pool.query(
        `INSERT INTO admin_roles (user_id, can_resolve_disputes)
         VALUES ($1, true)
         ON CONFLICT (user_id) DO UPDATE SET can_resolve_disputes = true`,
        [adminId]
      );
    } catch (e) {
      // admin_roles table might not exist - skip check for test
      console.log('⚠️  admin_roles table not found, skipping permission check (test will use direct SQL)');
    }

    // Create task (completed 1 hour ago)
    const completedAt = new Date(Date.now() - 60 * 60 * 1000);
    const taskResult = await pool.query(
      `INSERT INTO tasks (poster_id, worker_id, title, description, price, state, completed_at)
       VALUES ($1, $2, 'Test Task', 'Test Description', 10000, 'COMPLETED', $3)
       RETURNING id`,
      [posterId, workerId, completedAt]
    );
    const taskId = taskResult.rows[0].id;

    // Create escrow (FUNDED)
    const escrowResult = await pool.query(
      `INSERT INTO escrows (task_id, amount, state, stripe_payment_intent_id, version)
       VALUES ($1, 10000, 'FUNDED', 'pi_test_123', 1)
       RETURNING id`,
      [taskId]
    );
    const escrowId = escrowResult.rows[0].id;

    // Create dispute (OPEN)
    const disputeResult = await pool.query(
      `INSERT INTO disputes (task_id, escrow_id, initiated_by, poster_id, worker_id, reason, description, state, version)
       VALUES ($1, $2, $3, $4, $5, 'test', 'test dispute', 'OPEN', 1)
       RETURNING id`,
      [taskId, escrowId, posterId, posterId, workerId]
    );
    const disputeId = disputeResult.rows[0].id;

    // Lock escrow to LOCKED_DISPUTE (dispute creation would do this, but we're creating directly)
    await pool.query(
      `UPDATE escrows SET state = 'LOCKED_DISPUTE' WHERE id = $1`,
      [escrowId]
    );

    console.log(`✅ Test data created:`);
    console.log(`   task_id: ${taskId}`);
    console.log(`   escrow_id: ${escrowId}`);
    console.log(`   dispute_id: ${disputeId}\n`);

    // Step 2: Resolve dispute with SPLIT
    console.log('Step 2: Resolving dispute with SPLIT...');
    
    // For test: bypass admin check by directly updating dispute (test only)
    // In production, DisputeService.resolve() would handle this
    console.log('⚠️  Using direct SQL for dispute resolution (bypassing service for test)');
    
    await pool.query(
      `UPDATE disputes
       SET state = 'RESOLVED',
           resolved_by = $1,
           resolved_at = NOW(),
           resolution = 'split',
           resolution_notes = 'Test SPLIT resolution',
           outcome_escrow_action = 'SPLIT',
           outcome_refund_amount = 3000,
           outcome_release_amount = 7000,
           version = version + 1
       WHERE id = $2`,
      [adminId, disputeId]
    );

    // Create outbox events manually (simulating DisputeService)
    const { writeToOutbox } = await import('../backend/src/jobs/outbox-helpers.js');
    
    await writeToOutbox({
      eventType: 'dispute.resolved',
      aggregateType: 'dispute',
      aggregateId: disputeId,
      eventVersion: 2,
      payload: {
        dispute_id: disputeId,
        escrow_id: escrowId,
        task_id: taskId,
        actor_id: adminId,
        state: 'RESOLVED',
        version: 2,
      },
      queueName: 'critical_trust',
    });

    await writeToOutbox({
      eventType: 'escrow.partial_refund_requested',
      aggregateType: 'escrow',
      aggregateId: escrowId,
      eventVersion: 1,
      payload: {
        escrow_id: escrowId,
        task_id: taskId,
        dispute_id: disputeId,
        reason: 'dispute_resolution',
        refund_amount: 3000,
        release_amount: 7000,
      },
      queueName: 'critical_payments',
    });

    console.log('✅ Dispute resolved, outbox events created\n');

    // Step 3: Phase 1 - Fail transfer creation
    console.log('Step 3: Phase 1 - Processing with transfer failure (HX_FAIL_STRIPE_TRANSFER=1)...');
    
    // Get the outbox event for escrow.partial_refund_requested
    const outboxResult = await pool.query(
      `SELECT id, idempotency_key, payload
       FROM outbox_events
       WHERE event_type = 'escrow.partial_refund_requested'
         AND aggregate_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [escrowId]
    );

    if (outboxResult.rows.length === 0) {
      throw new Error('Outbox event not found');
    }

    const outboxEvent = outboxResult.rows[0];
    const payload = typeof outboxEvent.payload === 'string' 
      ? JSON.parse(outboxEvent.payload)
      : outboxEvent.payload;

    // Enqueue job directly (bypassing outbox poller)
    process.env.HX_FAIL_STRIPE_TRANSFER = '1';
    const job1 = await queue.add(
      'escrow.partial_refund_requested',
      {
        aggregate_type: 'escrow',
        aggregate_id: escrowId,
        event_version: 1,
        payload,
      },
      {
        jobId: outboxEvent.idempotency_key,
      }
    );

    console.log(`✅ Job enqueued: ${job1.id}`);
    console.log('👀 Check worker logs for processing...');

    // Wait for job to process (will fail)
    const state1 = await waitForJobCompletion(queue, job1.id, 15000);
    console.log(`✅ Job state: ${state1}\n`);

    // Get snapshot
    const escrow1 = await getEscrowSnapshot(pool, escrowId);
    printSnapshot('After Phase 1 (transfer failed)', escrow1);

    // Assertions
    if (escrow1.state !== 'LOCKED_DISPUTE') {
      throw new Error(`❌ FAIL: Escrow state is ${escrow1.state}, expected LOCKED_DISPUTE`);
    }
    if (escrow1.stripe_transfer_id !== null) {
      throw new Error(`❌ FAIL: stripe_transfer_id is ${escrow1.stripe_transfer_id}, expected NULL`);
    }
    console.log('✅ Phase 1 assertions passed\n');

    // Step 4: Phase 2 - Succeed (remove failure flag)
    console.log('Step 4: Phase 2 - Retrying with transfer success (HX_FAIL_STRIPE_TRANSFER unset)...');
    
    delete process.env.HX_FAIL_STRIPE_TRANSFER;

    // Re-enqueue same job (idempotency key ensures same job)
    const job2 = await queue.add(
      'escrow.partial_refund_requested',
      {
        aggregate_type: 'escrow',
        aggregate_id: escrowId,
        event_version: 1,
        payload,
      },
      {
        jobId: outboxEvent.idempotency_key, // Same idempotency key
      }
    );

    console.log(`✅ Job re-enqueued: ${job2.id}`);
    console.log('👀 Check worker logs for processing...');

    // Wait for job to process
    const state2 = await waitForJobCompletion(queue, job2.id, 15000);
    console.log(`✅ Job state: ${state2}\n`);

    // Get snapshot
    const escrow2 = await getEscrowSnapshot(pool, escrowId);
    printSnapshot('After Phase 2 (retry succeeded)', escrow2);

    // Assertions
    if (escrow2.state !== 'REFUND_PARTIAL') {
      throw new Error(`❌ FAIL: Escrow state is ${escrow2.state}, expected REFUND_PARTIAL`);
    }
    if (!escrow2.stripe_refund_id) {
      throw new Error(`❌ FAIL: stripe_refund_id is NULL, expected non-null`);
    }
    if (!escrow2.stripe_transfer_id) {
      throw new Error(`❌ FAIL: stripe_transfer_id is NULL, expected non-null`);
    }
    if (escrow2.refund_amount !== 3000) {
      throw new Error(`❌ FAIL: refund_amount is ${escrow2.refund_amount}, expected 3000`);
    }
    if (escrow2.release_amount !== 7000) {
      throw new Error(`❌ FAIL: release_amount is ${escrow2.release_amount}, expected 7000`);
    }
    console.log('✅ Phase 2 assertions passed\n');

    // Cleanup
    console.log('Cleaning up test data...');
    await pool.query('DELETE FROM disputes WHERE id = $1', [disputeId]);
    await pool.query('DELETE FROM escrows WHERE id = $1', [escrowId]);
    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [posterId, workerId, adminId]);
    console.log('✅ Cleanup complete\n');

    console.log('✅✅✅ Evil Test A PASSED ✅✅✅');
    console.log('EVIL_A_PASS');
    process.exit(0);

  } catch (error) {
    console.error('\n❌❌❌ Evil Test A FAILED ❌❌❌');
    console.error(error.message);
    if (error.stack) console.error(error.stack);
    console.log('EVIL_A_FAIL');
    process.exit(1);
  } finally {
    await pool.end();
    await redis.quit();
  }
})();
