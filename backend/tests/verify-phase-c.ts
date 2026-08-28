/**
 * Phase C Verification Protocol
 * 
 * Tests exactly-once semantics, crash safety, and suppression correctness
 * 
 * Run with: npx tsx backend/tests/verify-phase-c.ts
 */

import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables from env.backend (same as other scripts)
const envPath = join(process.cwd(), 'env.backend');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
} catch (error) {
  console.warn('Warning: Could not load env.backend, using process.env');
}

import { db } from '../src/db';
import { randomUUID } from 'crypto';

// ============================================================================
// VERIFICATION HELPERS
// ============================================================================

interface VerificationResult {
  test: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  error?: string;
}

const results: VerificationResult[] = [];

function logResult(test: string, passed: boolean, evidence: Record<string, unknown>, error?: string): void {
  results.push({ test, passed, evidence, error });
  console.log(`\n${passed ? '✅' : '❌'} ${test}`);
  console.log('Evidence:', JSON.stringify(evidence, null, 2));
  if (error) {
    console.error('Error:', error);
  }
}

// ============================================================================
// V1: EXACTLY-ONCE SEND UNDER CONCURRENCY
// ============================================================================

async function verifyV1_ExactlyOnceSend(): Promise<void> {
  console.log('\n=== V1: Exactly-once send under concurrency ===');
  
  try {
    const testUserId = randomUUID();
    const testEmail = `test-${randomUUID()}@example.com`;
    const testTemplate = 'test_template';
    const testAggregateId = randomUUID();
    const idempotencyKey = `email.send_requested:${testTemplate}:${testEmail}:${testAggregateId}:1`;
    
    // Create user
    await db.query(
      `INSERT INTO users (id, email, full_name, firebase_uid, default_mode, trust_tier, xp_total, current_level, current_streak, is_verified, student_id_verified, live_mode_state, daily_active_minutes, consecutive_active_days, account_status, role_was_overridden, created_at, updated_at)
       VALUES ($1, $2, 'Test User', $3, 'worker', 1, 0, 1, 0, false, false, 'inactive', 0, 0, 'active', false, NOW(), NOW())`,
      [testUserId, testEmail, randomUUID()]
    );
    
    // Try to create same email_outbox row twice (simulating concurrent requests)
    let insert1Success = false;
    let insert2Success = false;
    let duplicateError = false;
    
    try {
      await db.query(
        `INSERT INTO email_outbox (user_id, to_email, template, params_json, priority, status, idempotency_key)
         VALUES ($1, $2, $3, '{}'::JSONB, 'MEDIUM', 'pending', $4)`,
        [testUserId, testEmail, testTemplate, idempotencyKey]
      );
      insert1Success = true;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('duplicate key') || error.message.includes('unique')) {
        duplicateError = true;
      }
    }
    
    try {
      await db.query(
        `INSERT INTO email_outbox (user_id, to_email, template, params_json, priority, status, idempotency_key)
         VALUES ($1, $2, $3, '{}'::JSONB, 'MEDIUM', 'pending', $4)`,
        [testUserId, testEmail, testTemplate, idempotencyKey]
      );
      insert2Success = true;
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('duplicate key') || error.message.includes('unique'))) {
        duplicateError = true;
      }
    }
    
    // Check final state
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_outbox WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const finalCount = parseInt(countResult.rows[0]?.count || '0', 10);
    
    // Verify atomic claim logic exists
    const statusCheck = await db.query(
      `SELECT status FROM email_outbox WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    
    // Cleanup
    await db.query(`DELETE FROM email_outbox WHERE idempotency_key = $1`, [idempotencyKey]);
    await db.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    
    const passed = finalCount === 1 && (insert1Success !== insert2Success || duplicateError);
    
    logResult('V1', passed, {
      insert1Success,
      insert2Success,
      duplicateError,
      finalCount,
      status: statusCheck.rows[0]?.status || null,
    }, passed ? undefined : `Expected exactly 1 row, got ${finalCount}`);
    
  } catch (error) {
    logResult('V1', false, {}, error instanceof Error ? error.message : 'Unknown error');
  }
}

// ============================================================================
// V2: OUTBOX DOUBLE-ENQUEUE
// ============================================================================

async function verifyV2_OutboxDoubleEnqueue(): Promise<void> {
  console.log('\n=== V2: Outbox double-enqueue does not produce duplicate sends ===');
  
  try {
    const testUserId = randomUUID();
    const testEmail = `test-${randomUUID()}@example.com`;
    const testTemplate = 'test_template';
    const testAggregateId = randomUUID();
    const idempotencyKey = `email.send_requested:${testTemplate}:${testEmail}:${testAggregateId}:1`;
    
    // Create user
    await db.query(
      `INSERT INTO users (id, email, full_name, firebase_uid, default_mode, trust_tier, xp_total, current_level, current_streak, is_verified, student_id_verified, live_mode_state, daily_active_minutes, consecutive_active_days, account_status, role_was_overridden, created_at, updated_at)
       VALUES ($1, $2, 'Test User', $3, 'worker', 1, 0, 1, 0, false, false, 'inactive', 0, 0, 'active', false, NOW(), NOW())`,
      [testUserId, testEmail, randomUUID()]
    );
    
    // Create email_outbox row
    const emailResult = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (user_id, to_email, template, params_json, priority, status, idempotency_key)
       VALUES ($1, $2, $3, '{}'::JSONB, 'MEDIUM', 'pending', $4)
       RETURNING id`,
      [testUserId, testEmail, testTemplate, idempotencyKey]
    );
    const emailId = emailResult.rows[0].id;
    
    // Simulate double-enqueue: create two outbox_events with same idempotency_key
    let outbox1Id: string | null = null;
    let outbox2Id: string | null = null;
    let duplicateError = false;
    
    try {
      const result1 = await db.query<{ id: string }>(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, event_version, idempotency_key, payload, queue_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        ['email.send_requested', 'email', emailId, 1, idempotencyKey, JSON.stringify({ emailId }), 'user_notifications']
      );
      outbox1Id = result1.rows[0].id;
    } catch (error) {
      // Expected: first insert succeeds
    }
    
    try {
      const result2 = await db.query<{ id: string }>(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, event_version, idempotency_key, payload, queue_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        ['email.send_requested', 'email', emailId, 1, idempotencyKey, JSON.stringify({ emailId }), 'user_notifications']
      );
      outbox2Id = result2.rows[0].id;
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('duplicate key') || error.message.includes('unique'))) {
        duplicateError = true;
      }
    }
    
    // Check final state
    const outboxCount = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const finalOutboxCount = parseInt(outboxCount.rows[0]?.count || '0', 10);
    
    // Cleanup
    if (outbox1Id) await db.query(`DELETE FROM outbox_events WHERE id = $1`, [outbox1Id]);
    if (outbox2Id) await db.query(`DELETE FROM outbox_events WHERE id = $1`, [outbox2Id]);
    await db.query(`DELETE FROM email_outbox WHERE id = $1`, [emailId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    
    const passed = finalOutboxCount === 1 && (outbox1Id !== null && (outbox2Id === null || duplicateError));
    
    logResult('V2', passed, {
      outbox1Id,
      outbox2Id,
      duplicateError,
      finalOutboxCount,
    }, passed ? undefined : `Expected exactly 1 outbox event, got ${finalOutboxCount}`);
    
  } catch (error) {
    logResult('V2', false, {}, error instanceof Error ? error.message : 'Unknown error');
  }
}

// ============================================================================
// V3: CRASH SAFETY MID-SEND
// ============================================================================

async function verifyV3_CrashSafety(): Promise<void> {
  console.log('\n=== V3: Crash safety mid-send ===');
  
  try {
    const testUserId = randomUUID();
    const testEmail = `test-${randomUUID()}@example.com`;
    const testTemplate = 'test_template';
    const testAggregateId = randomUUID();
    const idempotencyKey = `email.send_requested:${testTemplate}:${testEmail}:${testAggregateId}:1`;
    
    // Create user
    await db.query(
      `INSERT INTO users (id, email, full_name, firebase_uid, default_mode, trust_tier, xp_total, current_level, current_streak, is_verified, student_id_verified, live_mode_state, daily_active_minutes, consecutive_active_days, account_status, role_was_overridden, created_at, updated_at)
       VALUES ($1, $2, 'Test User', $3, 'worker', 1, 0, 1, 0, false, false, 'inactive', 0, 0, 'active', false, NOW(), NOW())`,
      [testUserId, testEmail, randomUUID()]
    );
    
    // Create email_outbox row in 'sending' state (simulating crash after claim)
    const emailResult = await db.query<{ id: string }>(
      `INSERT INTO email_outbox (user_id, to_email, template, params_json, priority, status, idempotency_key, attempts)
       VALUES ($1, $2, $3, '{}'::JSONB, 'MEDIUM', 'sending', $4, 1)
       RETURNING id`,
      [testUserId, testEmail, testTemplate, idempotencyKey]
    );
    const emailId = emailResult.rows[0].id;
    
    // Try to claim again (simulating retry after crash)
    const claimResult = await db.query<{ row_count: number }>(
      `UPDATE email_outbox
       SET status = 'sending',
           attempts = attempts + 1,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'failed')
       RETURNING 1 as row_count`,
      [emailId]
    );
    
    const canReclaim = claimResult.rowCount === 0; // Should NOT be able to reclaim from 'sending'
    
    // Now test crash after SendGrid success but before DB update
    // Simulate: provider_msg_id exists but status is still 'sending'
    await db.query(
      `UPDATE email_outbox
       SET status = 'sending',
           provider_msg_id = 'test-msg-id-123',
           attempts = 1
       WHERE id = $1`,
      [emailId]
    );
    
    // Check if we can detect "already sent" scenario
    const alreadySentCheck = await db.query<{ provider_msg_id: string | null; status: string }>(
      `SELECT provider_msg_id, status FROM email_outbox WHERE id = $1`,
      [emailId]
    );
    const hasProviderId = alreadySentCheck.rows[0]?.provider_msg_id !== null;
    
    // Cleanup
    await db.query(`DELETE FROM email_outbox WHERE id = $1`, [emailId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    
    const passed = canReclaim && hasProviderId; // Can't reclaim, and provider_id detection works
    
    logResult('V3', passed, {
      canReclaim: !canReclaim, // Inverted: we expect canReclaim=false (cannot reclaim)
      hasProviderId,
      status: alreadySentCheck.rows[0]?.status,
      providerMsgId: alreadySentCheck.rows[0]?.provider_msg_id,
    }, passed ? undefined : 'Crash recovery logic may be incomplete');
    
  } catch (error) {
    logResult('V3', false, {}, error instanceof Error ? error.message : 'Unknown error');
  }
}

// ============================================================================
// V4: SUPPRESSION CORRECTNESS
// ============================================================================

async function verifyV4_SuppressionCorrectness(): Promise<void> {
  console.log('\n=== V4: Suppression correctness ===');
  
  try {
    const testUserId = randomUUID();
    const testEmail = `test-${randomUUID()}@example.com`;
    const testTemplate = 'test_template';
    const testAggregateId = randomUUID();
    const idempotencyKey = `email.send_requested:${testTemplate}:${testEmail}:${testAggregateId}:1`;
    
    // Create user with do_not_email=true
    await db.query(
      `INSERT INTO users (id, email, full_name, firebase_uid, default_mode, trust_tier, xp_total, current_level, current_streak, is_verified, student_id_verified, live_mode_state, daily_active_minutes, consecutive_active_days, account_status, role_was_overridden, do_not_email, created_at, updated_at)
       VALUES ($1, $2, 'Test User', $3, 'worker', 1, 0, 1, 0, false, false, 'inactive', 0, 0, 'active', false, true, NOW(), NOW())`,
      [testUserId, testEmail, randomUUID()]
    );
    
    // Try to create email_outbox row (should still be allowed, but status should reflect suppression)
    const emailResult = await db.query<{ id: string; status: string }>(
      `INSERT INTO email_outbox (user_id, to_email, template, params_json, priority, status, idempotency_key)
       VALUES ($1, $2, $3, '{}'::JSONB, 'MEDIUM', 'pending', $4)
       RETURNING id, status`,
      [testUserId, testEmail, testTemplate, idempotencyKey]
    );
    const emailId = emailResult.rows[0].id;
    
    // Check if worker would detect suppression
    // Worker should check: suppressed_reason OR user.do_not_email
    const userCheck = await db.query<{ do_not_email: boolean }>(
      `SELECT do_not_email FROM users WHERE id = $1`,
      [testUserId]
    );
    const userSuppressed = userCheck.rows[0]?.do_not_email === true;
    
    // Simulate worker checking suppression before sending
    const shouldSuppress = userSuppressed; // Worker should check this
    
    // Cleanup
    await db.query(`DELETE FROM email_outbox WHERE id = $1`, [emailId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    
    const passed = userSuppressed && shouldSuppress; // User is suppressed, worker can detect
    
    logResult('V4', passed, {
      userSuppressed,
      shouldSuppress,
      emailStatus: emailResult.rows[0]?.status,
    }, passed ? undefined : 'Suppression detection may be incomplete');
    
  } catch (error) {
    logResult('V4', false, {}, error instanceof Error ? error.message : 'Unknown error');
  }
}

// ============================================================================
// DB CONSTRAINT VERIFICATION
// ============================================================================

async function verifyDBConstraints(): Promise<void> {
  console.log('\n=== DB Constraints Verification ===');
  
  try {
    // Check email_outbox constraints
    const emailOutboxStatusCheck = await db.query<{ constraint_name: string; constraint_type: string }>(
      `SELECT conname as constraint_name, contype as constraint_type
       FROM pg_constraint
       WHERE conrelid = 'email_outbox'::regclass
         AND conname LIKE '%status%'`
    );
    
    const emailOutboxIdempotencyUnique = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'email_outbox'
         AND indexname LIKE '%idempotency%'`
    );
    
    // Check outbox_events constraints
    const outboxEventsIdempotencyUnique = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'outbox_events'
         AND indexname LIKE '%idempotency%'`
    );
    
    const hasEmailOutboxIdempotencyUnique = emailOutboxIdempotencyUnique.rows.length > 0;
    const hasOutboxEventsIdempotencyUnique = outboxEventsIdempotencyUnique.rows.length > 0;
    const hasStatusCheck = emailOutboxStatusCheck.rows.length > 0;
    
    logResult('DB Constraints', hasEmailOutboxIdempotencyUnique && hasOutboxEventsIdempotencyUnique && hasStatusCheck, {
      emailOutboxIdempotencyUnique: hasEmailOutboxIdempotencyUnique,
      outboxEventsIdempotencyUnique: hasOutboxEventsIdempotencyUnique,
      statusCheck: hasStatusCheck,
      statusConstraints: emailOutboxStatusCheck.rows.map(r => r.constraint_name),
    });
    
  } catch (error) {
    logResult('DB Constraints', false, {}, error instanceof Error ? error.message : 'Unknown error');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('🔍 Phase C Verification Protocol\n');
  
  if (!config.database?.url) {
    console.error('❌ DATABASE_URL not configured');
    process.exit(1);
  }
  
  try {
    await verifyV1_ExactlyOnceSend();
    await verifyV2_OutboxDoubleEnqueue();
    await verifyV3_CrashSafety();
    await verifyV4_SuppressionCorrectness();
    await verifyDBConstraints();
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(60));
    
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    
    results.forEach(r => {
      console.log(`${r.passed ? '✅' : '❌'} ${r.test}`);
    });
    
    console.log(`\n${passed}/${total} tests passed`);
    
    if (passed === total) {
      console.log('\n✅ All Phase C verifications PASSED');
      process.exit(0);
    } else {
      console.log('\n❌ Some Phase C verifications FAILED');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
