/**
 * Concurrency Load Test v1.0.0
 *
 * Sprint 3: Prove the trigger layer holds under concurrent load.
 *
 * Scenarios tested:
 * 1. 100 concurrent escrow releases (same escrow — only 1 should succeed)
 * 2. 100 concurrent task state transitions (race conditions)
 * 3. 50 concurrent revenue_ledger inserts (append-only writes)
 * 4. 20 concurrent payout freeze + release (deadlock detection)
 * 5. 50 concurrent subscription limit enforcement
 *
 * Metrics collected:
 * - Average latency, P95 latency
 * - Lock wait time (pg_stat_activity)
 * - Deadlock count (pg_stat_database)
 * - Success/failure counts
 * - CPU time (process.hrtime)
 *
 * Usage:
 *   npx tsx scripts/concurrency-load-test.ts
 *   npx tsx scripts/concurrency-load-test.ts --scenario escrow
 *   npx tsx scripts/concurrency-load-test.ts --scenario all --concurrency 50
 */

import pg from 'pg';

// ============================================================================
// CONFIG
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable required');
  process.exit(1);
}

const args = process.argv.slice(2);
const scenarioArg = args.find((_, i) => args[i - 1] === '--scenario') || 'all';
const concurrencyArg = args.find((_, i) => args[i - 1] === '--concurrency');
const DEFAULT_CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg, 10) : 100;

const TEST_RUN_ID = `load_${Date.now().toString(36)}`;

// ============================================================================
// TYPES
// ============================================================================

interface LoadResult {
  scenario: string;
  concurrency: number;
  totalMs: number;
  successCount: number;
  failureCount: number;
  expectedFailures: number;
  latencies: number[];
  errors: string[];
  deadlocks: number;
  lockWaitMs: number;
}

interface MetricsSummary {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function calcMetrics(latencies: number[]): MetricsSummary {
  if (latencies.length === 0) {
    return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, minMs: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    p99Ms: sorted[Math.floor(sorted.length * 0.99)],
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
  };
}

async function getDeadlockCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`
    SELECT COALESCE(deadlocks, 0) as deadlocks
    FROM pg_stat_database
    WHERE datname = current_database()
  `);
  return parseInt(result.rows[0]?.deadlocks || '0', 10);
}

async function timedQuery(
  pool: pg.Pool,
  query: string,
  params: any[]
): Promise<{ durationMs: number; rows: any[]; rowCount: number; error?: string }> {
  const start = performance.now();
  try {
    const result = await pool.query(query, params);
    return {
      durationMs: Math.round(performance.now() - start),
      rows: result.rows,
      rowCount: result.rowCount || 0,
    };
  } catch (error: any) {
    return {
      durationMs: Math.round(performance.now() - start),
      rows: [],
      rowCount: 0,
      error: `${error.code || 'UNKNOWN'}: ${error.message?.substring(0, 100)}`,
    };
  }
}

function printResult(result: LoadResult) {
  const metrics = calcMetrics(result.latencies);
  console.log(`\n--- ${result.scenario} ---`);
  console.log(`  Concurrency:  ${result.concurrency}`);
  console.log(`  Total time:   ${result.totalMs}ms`);
  console.log(`  Successes:    ${result.successCount}`);
  console.log(`  Failures:     ${result.failureCount} (expected: ${result.expectedFailures})`);
  console.log(`  Deadlocks:    ${result.deadlocks}`);
  console.log(`  Avg latency:  ${metrics.avgMs}ms`);
  console.log(`  P50 latency:  ${metrics.p50Ms}ms`);
  console.log(`  P95 latency:  ${metrics.p95Ms}ms`);
  console.log(`  P99 latency:  ${metrics.p99Ms}ms`);
  console.log(`  Max latency:  ${metrics.maxMs}ms`);
  if (result.errors.length > 0) {
    const uniqueErrors = [...new Set(result.errors)];
    console.log(`  Unique errors (${uniqueErrors.length}):`);
    uniqueErrors.slice(0, 5).forEach(e => console.log(`    - ${e}`));
  }

  // PASS/FAIL determination
  const unexpectedFailures = result.failureCount - result.expectedFailures;
  if (result.deadlocks > 0) {
    console.log(`  RESULT: FAIL (${result.deadlocks} deadlocks detected)`);
  } else if (unexpectedFailures > 0) {
    console.log(`  RESULT: FAIL (${unexpectedFailures} unexpected failures)`);
  } else {
    console.log(`  RESULT: PASS`);
  }
}

// ============================================================================
// SCENARIO 1: CONCURRENT ESCROW RELEASE (same escrow)
// ============================================================================
// 100 threads try to release the same FUNDED escrow.
// Expected: exactly 1 succeeds, 99 fail (wrong state or no rows).
// Tests: SELECT FOR UPDATE contention, terminal state guards.

async function scenarioEscrowRelease(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  // Setup: create user, task, escrow
  const email = `${TEST_RUN_ID}-escrow@hustlexp.test`;
  const userId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Load Test Poster', 'poster') RETURNING id`,
    [email]
  )).rows[0].id;

  const workerId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Load Test Worker', 'worker') RETURNING id`,
    [`${TEST_RUN_ID}-worker@hustlexp.test`]
  )).rows[0].id;

  const taskId = (await pool.query(
    `INSERT INTO tasks (poster_id, worker_id, title, description, price, state) VALUES ($1, $2, 'Load Test Task', 'Desc', 5000, 'COMPLETED') RETURNING id`,
    [userId, workerId]
  )).rows[0].id;

  const escrowId = (await pool.query(
    `INSERT INTO escrows (task_id, amount, state) VALUES ($1, 5000, 'FUNDED') RETURNING id`,
    [taskId]
  )).rows[0].id;

  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  const start = performance.now();

  // Fire concurrency simultaneous release attempts
  const promises = Array.from({ length: concurrency }, async () => {
    const result = await timedQuery(pool,
      `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1 AND state = 'FUNDED' RETURNING id`,
      [escrowId]
    );
    latencies.push(result.durationMs);
    if (result.error) {
      failures++;
      errors.push(result.error);
    } else if (result.rowCount === 0) {
      failures++; // State already changed
    } else {
      successes++;
    }
  });

  await Promise.all(promises);
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'CONCURRENT ESCROW RELEASE (same escrow)',
    concurrency,
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures: concurrency - 1, // Only 1 should win
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// SCENARIO 2: CONCURRENT TASK STATE TRANSITIONS
// ============================================================================
// 100 tasks transition OPEN → ACCEPTED concurrently.
// Expected: all 100 succeed (different rows, no contention).
// Tests: trigger throughput, index performance under load.

async function scenarioTaskTransitions(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  const email = `${TEST_RUN_ID}-tasktrans@hustlexp.test`;
  const userId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Load Test Poster', 'poster') RETURNING id`,
    [email]
  )).rows[0].id;

  const workerId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Load Test Worker', 'worker') RETURNING id`,
    [`${TEST_RUN_ID}-tasktrans-w@hustlexp.test`]
  )).rows[0].id;

  // Create N tasks
  const taskIds: string[] = [];
  for (let i = 0; i < concurrency; i++) {
    const result = await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state) VALUES ($1, $2, 'Desc', 5000, 'OPEN') RETURNING id`,
      [userId, `Load Task ${i}`]
    );
    taskIds.push(result.rows[0].id);
  }

  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  const start = performance.now();

  const promises = taskIds.map(async (taskId) => {
    const result = await timedQuery(pool,
      `UPDATE tasks SET state = 'ACCEPTED', worker_id = $2 WHERE id = $1 AND state = 'OPEN' RETURNING id`,
      [taskId, workerId]
    );
    latencies.push(result.durationMs);
    if (result.error) {
      failures++;
      errors.push(result.error);
    } else if (result.rowCount === 0) {
      failures++;
    } else {
      successes++;
    }
  });

  await Promise.all(promises);
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'CONCURRENT TASK STATE TRANSITIONS (OPEN→ACCEPTED)',
    concurrency,
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures: 0, // All should succeed (different rows)
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// SCENARIO 3: CONCURRENT REVENUE LEDGER INSERTS
// ============================================================================
// 100 concurrent revenue_ledger inserts (append-only, no contention expected).
// Tests: INSERT throughput, no deadlocks on append-only table.

async function scenarioRevenueLedgerInserts(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  const email = `${TEST_RUN_ID}-rev@hustlexp.test`;
  const userId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Load Test User', 'worker') RETURNING id`,
    [email]
  )).rows[0].id;

  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  const start = performance.now();

  const promises = Array.from({ length: concurrency }, async (_, i) => {
    const result = await timedQuery(pool,
      `INSERT INTO revenue_ledger (event_type, user_id, amount_cents, currency, gross_amount_cents, platform_fee_cents, net_amount_cents, fee_basis_points, metadata)
       VALUES ('platform_fee', $1, $2, 'usd', $3, $2, $4, 1500, $5)
       RETURNING id`,
      [userId, 750, 5000, 4250, JSON.stringify({ loadTest: true, index: i, runId: TEST_RUN_ID })]
    );
    latencies.push(result.durationMs);
    if (result.error) {
      failures++;
      errors.push(result.error);
    } else {
      successes++;
    }
  });

  await Promise.all(promises);
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'CONCURRENT REVENUE LEDGER INSERTS',
    concurrency,
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures: 0,
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// SCENARIO 4: CONCURRENT PAYOUT FREEZE + ESCROW RELEASE
// ============================================================================
// Thread A freezes user payouts, Thread B tries to release escrow.
// Expected: release is blocked by HX810 trigger when payouts_locked = TRUE.
// Tests: cross-table trigger interaction, no deadlocks.

async function scenarioPayoutFreezeRace(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  const pairs = Math.min(concurrency, 20); // Cap at 20 pairs
  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;
  let expectedFailures = 0;

  const start = performance.now();

  const promises = Array.from({ length: pairs }, async (_, i) => {
    // Setup per-pair
    const posterId = (await pool.query(
      `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Poster', 'poster') RETURNING id`,
      [`${TEST_RUN_ID}-freeze-p${i}@hustlexp.test`]
    )).rows[0].id;

    const workerId = (await pool.query(
      `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Worker', 'worker') RETURNING id`,
      [`${TEST_RUN_ID}-freeze-w${i}@hustlexp.test`]
    )).rows[0].id;

    const taskId = (await pool.query(
      `INSERT INTO tasks (poster_id, worker_id, title, description, price, state) VALUES ($1, $2, 'Freeze Test', 'Desc', 5000, 'COMPLETED') RETURNING id`,
      [posterId, workerId]
    )).rows[0].id;

    const escrowId = (await pool.query(
      `INSERT INTO escrows (task_id, amount, state) VALUES ($1, 5000, 'FUNDED') RETURNING id`,
      [taskId]
    )).rows[0].id;

    // Race: freeze payouts THEN try release
    // Thread A: freeze
    const freezeResult = await timedQuery(pool,
      `UPDATE users SET payouts_locked = TRUE, payouts_locked_at = NOW(), payouts_locked_reason = 'load test' WHERE id = $1`,
      [workerId]
    );
    latencies.push(freezeResult.durationMs);
    if (freezeResult.error) {
      failures++;
      errors.push(freezeResult.error);
    } else {
      successes++;
    }

    // Thread B: try release (should be blocked by trigger HX810)
    const releaseResult = await timedQuery(pool,
      `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1 AND state = 'FUNDED'`,
      [escrowId]
    );
    latencies.push(releaseResult.durationMs);
    if (releaseResult.error && releaseResult.error.includes('HX810')) {
      failures++;
      expectedFailures++;
      // This is EXPECTED — trigger blocked the release
    } else if (releaseResult.error) {
      failures++;
      errors.push(releaseResult.error);
    } else if (releaseResult.rowCount === 0) {
      failures++; // No row matched
    } else {
      // Should NOT succeed if freeze happened first
      errors.push('UNEXPECTED: Escrow released despite payouts_locked');
      successes++;
    }
  });

  await Promise.all(promises);
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'CONCURRENT PAYOUT FREEZE + ESCROW RELEASE',
    concurrency: pairs * 2, // 2 operations per pair
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures,
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// SCENARIO 5: CONCURRENT SUBSCRIPTION LIMIT ENFORCEMENT
// ============================================================================
// User has recurring_task_limit = 3. 10 threads try to create recurring series.
// Expected: 3 succeed, 7 fail with HX501.
// Tests: recurring_subscription_guard trigger under contention.

async function scenarioSubscriptionLimit(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  const email = `${TEST_RUN_ID}-sublimit@hustlexp.test`;
  const userId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode, recurring_task_limit, plan) VALUES ($1, 'Sub User', 'poster', 3, 'premium') RETURNING id`,
    [email]
  )).rows[0].id;

  const attempts = Math.min(concurrency, 10);
  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  const start = performance.now();

  // Check if recurring_task_series table exists
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'recurring_task_series'
    ) as exists
  `);

  if (!tableCheck.rows[0].exists) {
    return {
      scenario: 'CONCURRENT SUBSCRIPTION LIMIT ENFORCEMENT',
      concurrency: attempts,
      totalMs: 0,
      successCount: 0,
      failureCount: 0,
      expectedFailures: 0,
      latencies: [],
      errors: ['SKIPPED: recurring_task_series table does not exist'],
      deadlocks: 0,
      lockWaitMs: 0,
    };
  }

  const promises = Array.from({ length: attempts }, async (_, i) => {
    const result = await timedQuery(pool,
      `INSERT INTO recurring_task_series (poster_id, title, description, price, frequency, status)
       VALUES ($1, $2, 'Load test series', 5000, 'weekly', 'active')
       RETURNING id`,
      [userId, `Recurring ${i}`]
    );
    latencies.push(result.durationMs);
    if (result.error) {
      failures++;
      if (!result.error.includes('HX501')) {
        errors.push(result.error);
      }
    } else {
      successes++;
    }
  });

  await Promise.all(promises);
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'CONCURRENT SUBSCRIPTION LIMIT ENFORCEMENT',
    concurrency: attempts,
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures: Math.max(0, attempts - 3), // Only 3 should succeed
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// SCENARIO 6: MIXED WORKLOAD STRESS TEST
// ============================================================================
// Simulates realistic system behavior: escrow releases, ledger inserts,
// task transitions, and payout freezes all happening simultaneously.
// 200 total operations with randomized distribution.
// Tests: cross-table deadlocks under realistic mixed load.

async function scenarioMixedWorkload(pool: pg.Pool, concurrency: number): Promise<LoadResult> {
  const total = Math.min(concurrency * 2, 200);

  // Setup: shared resources
  const posterEmail = `${TEST_RUN_ID}-mixed-p@hustlexp.test`;
  const posterId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Mixed Poster', 'poster') RETURNING id`,
    [posterEmail]
  )).rows[0].id;

  const workerEmail = `${TEST_RUN_ID}-mixed-w@hustlexp.test`;
  const workerId = (await pool.query(
    `INSERT INTO users (email, full_name, default_mode) VALUES ($1, 'Mixed Worker', 'worker') RETURNING id`,
    [workerEmail]
  )).rows[0].id;

  // Pre-create tasks and escrows for release operations
  const taskIds: string[] = [];
  const escrowIds: string[] = [];
  const openTaskIds: string[] = [];
  const releaseCount = Math.floor(total * 0.25);
  const transitionCount = Math.floor(total * 0.25);

  for (let i = 0; i < releaseCount; i++) {
    const taskId = (await pool.query(
      `INSERT INTO tasks (poster_id, worker_id, title, description, price, state) VALUES ($1, $2, $3, 'Desc', 5000, 'COMPLETED') RETURNING id`,
      [posterId, workerId, `Mixed Release ${i}`]
    )).rows[0].id;
    taskIds.push(taskId);
    const escrowId = (await pool.query(
      `INSERT INTO escrows (task_id, amount, state) VALUES ($1, 5000, 'FUNDED') RETURNING id`,
      [taskId]
    )).rows[0].id;
    escrowIds.push(escrowId);
  }

  for (let i = 0; i < transitionCount; i++) {
    const taskId = (await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state) VALUES ($1, $2, 'Desc', 5000, 'OPEN') RETURNING id`,
      [posterId, `Mixed Transition ${i}`]
    )).rows[0].id;
    openTaskIds.push(taskId);
  }

  const deadlocksBefore = await getDeadlockCount(pool);
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  // Build mixed workload
  type WorkItem = () => Promise<void>;
  const work: WorkItem[] = [];

  // 25% escrow releases
  escrowIds.forEach((escrowId) => {
    work.push(async () => {
      const r = await timedQuery(pool,
        `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1 AND state = 'FUNDED' RETURNING id`,
        [escrowId]
      );
      latencies.push(r.durationMs);
      if (r.error) { failures++; errors.push(r.error); }
      else if (r.rowCount > 0) successes++;
      else failures++;
    });
  });

  // 25% task transitions
  openTaskIds.forEach((taskId) => {
    work.push(async () => {
      const r = await timedQuery(pool,
        `UPDATE tasks SET state = 'ACCEPTED', worker_id = $2 WHERE id = $1 AND state = 'OPEN' RETURNING id`,
        [taskId, workerId]
      );
      latencies.push(r.durationMs);
      if (r.error) { failures++; errors.push(r.error); }
      else if (r.rowCount > 0) successes++;
      else failures++;
    });
  });

  // 25% ledger inserts
  const ledgerCount = Math.floor(total * 0.25);
  for (let i = 0; i < ledgerCount; i++) {
    work.push(async () => {
      const r = await timedQuery(pool,
        `INSERT INTO revenue_ledger (event_type, user_id, amount_cents, currency, gross_amount_cents, platform_fee_cents, net_amount_cents, metadata)
         VALUES ('platform_fee', $1, 750, 'usd', 5000, 750, 4250, $2)
         RETURNING id`,
        [workerId, JSON.stringify({ loadTest: true, mixed: true, index: i, runId: TEST_RUN_ID })]
      );
      latencies.push(r.durationMs);
      if (r.error) { failures++; errors.push(r.error); }
      else successes++;
    });
  }

  // 25% user updates (trust tier, plan changes)
  const userUpdateCount = total - releaseCount - transitionCount - ledgerCount;
  for (let i = 0; i < userUpdateCount; i++) {
    work.push(async () => {
      const targetId = i % 2 === 0 ? posterId : workerId;
      const r = await timedQuery(pool,
        `UPDATE users SET xp_balance = COALESCE(xp_balance, 0) + $2 WHERE id = $1`,
        [targetId, Math.floor(Math.random() * 100)]
      );
      latencies.push(r.durationMs);
      if (r.error) { failures++; errors.push(r.error); }
      else successes++;
    });
  }

  // Shuffle to randomize order
  for (let i = work.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [work[i], work[j]] = [work[j], work[i]];
  }

  const start = performance.now();
  await Promise.all(work.map(fn => fn()));
  const totalMs = Math.round(performance.now() - start);
  const deadlocksAfter = await getDeadlockCount(pool);

  return {
    scenario: 'MIXED WORKLOAD STRESS TEST (escrow+task+ledger+user)',
    concurrency: total,
    totalMs,
    successCount: successes,
    failureCount: failures,
    expectedFailures: 0, // All operations on different rows
    latencies,
    errors,
    deadlocks: deadlocksAfter - deadlocksBefore,
    lockWaitMs: 0,
  };
}

// ============================================================================
// LOCK WAIT + DEADLOCK METRICS
// ============================================================================

async function getLockMetrics(pool: pg.Pool): Promise<{
  activeLocks: number;
  waitingQueries: number;
  avgLockWaitMs: number;
}> {
  const locks = await pool.query(`
    SELECT COUNT(*) as active_locks FROM pg_locks WHERE granted = true
  `);

  const waiting = await pool.query(`
    SELECT COUNT(*) as waiting FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
      AND state = 'active'
  `);

  return {
    activeLocks: parseInt(locks.rows[0].active_locks, 10),
    waitingQueries: parseInt(waiting.rows[0].waiting, 10),
    avgLockWaitMs: 0, // Neon doesn't expose pg_stat_statements easily
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Math.min(DEFAULT_CONCURRENCY + 5, 50), // Cap pool size
    idleTimeoutMillis: 30000,
  });

  try {
    console.log('='.repeat(80));
    console.log('HUSTLEXP CONCURRENCY LOAD TEST');
    console.log('='.repeat(80));
    console.log(`Run ID:      ${TEST_RUN_ID}`);
    console.log(`Concurrency: ${DEFAULT_CONCURRENCY}`);
    console.log(`Scenario:    ${scenarioArg}`);
    console.log(`Database:    ${DATABASE_URL?.replace(/\/\/.*@/, '//<redacted>@')}`);
    console.log('');

    const results: LoadResult[] = [];

    // Pre-test lock metrics
    const locksBefore = await getLockMetrics(pool);
    console.log(`Pre-test: ${locksBefore.activeLocks} active locks, ${locksBefore.waitingQueries} waiting`);

    if (scenarioArg === 'all' || scenarioArg === 'escrow') {
      results.push(await scenarioEscrowRelease(pool, DEFAULT_CONCURRENCY));
    }

    if (scenarioArg === 'all' || scenarioArg === 'tasks') {
      results.push(await scenarioTaskTransitions(pool, DEFAULT_CONCURRENCY));
    }

    if (scenarioArg === 'all' || scenarioArg === 'ledger') {
      results.push(await scenarioRevenueLedgerInserts(pool, DEFAULT_CONCURRENCY));
    }

    if (scenarioArg === 'all' || scenarioArg === 'freeze') {
      results.push(await scenarioPayoutFreezeRace(pool, DEFAULT_CONCURRENCY));
    }

    if (scenarioArg === 'all' || scenarioArg === 'subscription') {
      results.push(await scenarioSubscriptionLimit(pool, DEFAULT_CONCURRENCY));
    }

    if (scenarioArg === 'all' || scenarioArg === 'mixed') {
      results.push(await scenarioMixedWorkload(pool, DEFAULT_CONCURRENCY));
    }

    // Post-test lock metrics
    const locksAfter = await getLockMetrics(pool);
    console.log(`\nPost-test: ${locksAfter.activeLocks} active locks, ${locksAfter.waitingQueries} waiting`);

    // Print all results
    console.log('\n' + '='.repeat(80));
    console.log('RESULTS SUMMARY');
    console.log('='.repeat(80));

    results.forEach(printResult);

    // Overall pass/fail
    const totalDeadlocks = results.reduce((s, r) => s + r.deadlocks, 0);
    const hasUnexpectedFailures = results.some(r => {
      const unexpected = r.failureCount - r.expectedFailures;
      return unexpected > 0;
    });

    console.log('\n' + '='.repeat(80));
    if (totalDeadlocks > 0) {
      console.log('OVERALL: FAIL — Deadlocks detected');
    } else if (hasUnexpectedFailures) {
      console.log('OVERALL: FAIL — Unexpected failures');
    } else {
      console.log('OVERALL: PASS — No deadlocks, all failures expected');
    }
    console.log('='.repeat(80));

    // Cleanup load test data
    console.log('\nCleaning up load test data...');
    const pattern = `${TEST_RUN_ID}%`;
    await pool.query(`DELETE FROM escrows WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))`, [pattern]);
    await pool.query(`DELETE FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1)`, [pattern]);
    // Note: revenue_ledger entries are append-only — cannot delete.
    // They have loadTest: true in metadata for identification.
    console.log('Cleanup complete (revenue_ledger test entries retained — append-only).');

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
