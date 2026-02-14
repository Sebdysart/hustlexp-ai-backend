/**
 * HustleXP Backend Load Test — 200+ Concurrent Users
 *
 * Simulates peak load across every critical subsystem:
 *   1. Connection pool saturation (200 concurrent DB hits)
 *   2. User profile reads under contention
 *   3. Task feed (complex JOIN) under load
 *   4. Task search (ILIKE) under load
 *   5. Task create + read lifecycle
 *   6. Escrow reads under contention
 *   7. XP ledger writes (append-only)
 *   8. Notification reads
 *   9. AI audit trail writes
 *  10. Mixed read/write contention
 *  11. Complex aggregation queries
 *  12. Transaction safety (BEGIN/COMMIT)
 *
 * Run: npx tsx backend/src/tests/load-test-200.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================
interface SubsystemResult {
  subsystem: string;
  concurrency: number;
  totalOps: number;
  successCount: number;
  errorCount: number;
  p50: number;
  p95: number;
  p99: number;
  maxLatency: number;
  minLatency: number;
  avgLatency: number;
  throughput: number;
  errors: string[];
  passed: boolean;
}

// ============================================================================
// LOAD ENV + IMPORTS
// ============================================================================
let db: any;

async function loadEnv() {
  const envPath = path.resolve(import.meta.dirname || __dirname, '../../../.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) {
        const eq = t.indexOf('=');
        if (eq > 0 && !process.env[t.substring(0, eq)]) {
          process.env[t.substring(0, eq)] = t.substring(eq + 1);
        }
      }
    }
  }
  const dbMod = await import('../db');
  db = dbMod.db;
}

// ============================================================================
// UTILITIES
// ============================================================================
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function runConcurrent(
  subsystem: string,
  concurrency: number,
  opsPerUser: number,
  operation: (userId: number, opIndex: number) => Promise<void>
): Promise<SubsystemResult> {
  const latencies: number[] = [];
  const errors: string[] = [];
  let successCount = 0;
  let errorCount = 0;

  const startTime = Date.now();

  const userPromises = Array.from({ length: concurrency }, async (_, userId) => {
    for (let op = 0; op < opsPerUser; op++) {
      const opStart = Date.now();
      try {
        await operation(userId, op);
        latencies.push(Date.now() - opStart);
        successCount++;
      } catch (err) {
        latencies.push(Date.now() - opStart);
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        if (errors.length < 10) errors.push(msg.substring(0, 150));
      }
    }
  });

  await Promise.all(userPromises);
  const totalDuration = Date.now() - startTime;

  latencies.sort((a, b) => a - b);
  const totalOps = successCount + errorCount;

  return {
    subsystem,
    concurrency,
    totalOps,
    successCount,
    errorCount,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    maxLatency: latencies[latencies.length - 1] || 0,
    minLatency: latencies[0] || 0,
    avgLatency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    throughput: totalOps > 0 ? Math.round((totalOps / totalDuration) * 1000) : 0,
    errors,
    passed: errorCount === 0 && totalOps === concurrency * opsPerUser,
  };
}

// ============================================================================
// SUBSYSTEM TESTS
// (All column names verified against actual Neon schema 2026-02-14)
// ============================================================================

/** 1. Connection Pool Saturation — 200 concurrent SELECT NOW() */
async function testConnectionPool(): Promise<SubsystemResult> {
  return runConcurrent('1. Connection Pool (200×5)', 200, 5, async () => {
    await db.query('SELECT NOW()');
  });
}

/** 2. User Profile Reads — 200 users querying profiles concurrently */
async function testUserProfileReads(): Promise<SubsystemResult> {
  const users = await db.query('SELECT id FROM users LIMIT 1');
  const userId = users.rows.length > 0 ? users.rows[0].id : uuid();

  return runConcurrent('2. User Profile Reads (200×3)', 200, 3, async () => {
    await db.query(
      `SELECT id, email, name, role, trust_score, trust_tier, xp_total,
              current_streak, is_verified, account_status, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
  });
}

/** 3. Task Feed — 200 users pulling task feeds (JOIN + ORDER) */
async function testTaskFeed(): Promise<SubsystemResult> {
  return runConcurrent('3. Task Feed JOIN (200×2)', 200, 2, async () => {
    await db.query(
      `SELECT t.id, t.title, t.description, t.recommended_price, t.status, t.category,
              t.latitude, t.longitude, t.created_at,
              u.name AS poster_name, u.trust_score
       FROM tasks t
       JOIN users u ON t.client_id = u.id
       WHERE t.status = 'OPEN'
       ORDER BY t.created_at DESC
       LIMIT 20 OFFSET $1`,
      [Math.floor(Math.random() * 50)]
    );
  });
}

/** 4. Task Search — 200 concurrent ILIKE searches */
async function testTaskSearch(): Promise<SubsystemResult> {
  const terms = ['clean', 'delivery', 'move', 'repair', 'lawn', 'paint', 'photo', 'walk'];
  return runConcurrent('4. Task Search ILIKE (200×2)', 200, 2, async (userId) => {
    const term = terms[userId % terms.length];
    await db.query(
      `SELECT id, title, recommended_price, status, category, created_at
       FROM tasks
       WHERE (title ILIKE $1 OR description ILIKE $1)
       ORDER BY created_at DESC
       LIMIT 20`,
      [`%${term}%`]
    );
  });
}

/** 5. Task Create + Read — 50 writers + 150 readers */
async function testTaskLifecycle(): Promise<SubsystemResult> {
  const users = await db.query('SELECT id FROM users LIMIT 1');
  const clientId = users.rows.length > 0 ? users.rows[0].id : uuid();

  return runConcurrent('5. Task Create+Read (200×2)', 200, 2, async (userId, opIdx) => {
    if (userId < 50 && opIdx === 0) {
      await db.query(
        `INSERT INTO tasks (id, title, description, recommended_price, client_id, status, category)
         VALUES ($1, $2, $3, $4, $5, 'LOAD_TEST', 'general')
         RETURNING id`,
        [uuid(), `LoadTest-${userId}-${opIdx}`, `Stress test task ${userId}`, 1000 + userId * 10, clientId]
      );
    } else {
      await db.query(
        `SELECT id, title, recommended_price, status FROM tasks ORDER BY created_at DESC LIMIT 10`
      );
    }
  });
}

/** 6. Escrow Reads — 200 concurrent escrow queries */
async function testEscrowReads(): Promise<SubsystemResult> {
  return runConcurrent('6. Escrow Reads (200×3)', 200, 3, async () => {
    await db.query(
      `SELECT id, task_id, poster_id, hustler_id, amount, status, created_at
       FROM escrow
       ORDER BY created_at DESC
       LIMIT 10`
    );
  });
}

/** 7. XP Ledger Writes — 200 concurrent xp_events inserts */
async function testXPWrites(): Promise<SubsystemResult> {
  const users = await db.query('SELECT id FROM users LIMIT 1');
  const userId = users.rows.length > 0 ? users.rows[0].id : uuid();

  return runConcurrent('7. XP Writes (200×2)', 200, 2, async (uId, opIdx) => {
    await db.query(
      `INSERT INTO xp_events (id, user_id, amount, reason)
       VALUES ($1, $2, $3, $4)`,
      [uuid(), userId, 10 + uId, 'LOAD_TEST']
    );
  });
}

/** 8. Notification Reads — 200 concurrent notification queries */
async function testNotificationReads(): Promise<SubsystemResult> {
  return runConcurrent('8. Notification Reads (200×3)', 200, 3, async () => {
    await db.query(
      `SELECT id, user_id, type, channel, payload, status, created_at
       FROM notifications
       ORDER BY created_at DESC
       LIMIT 20`
    );
  });
}

/** 9. AI Audit Trail Writes — 200 concurrent ai_events inserts */
async function testAIEventWrites(): Promise<SubsystemResult> {
  return runConcurrent('9. AI Event Writes (200×2)', 200, 2, async (userId, opIdx) => {
    await db.query(
      `INSERT INTO ai_events (id, model_used, task_type, tokens_in, tokens_out, success, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [uuid(), 'load-test', 'stress_test', 100, 200, true]
    );
  });
}

/** 10. AI Agent Decisions Writes — 200 concurrent inserts to audit trail */
async function testAIDecisionWrites(): Promise<SubsystemResult> {
  return runConcurrent('10. AI Decision Writes (200×2)', 200, 2, async (userId, opIdx) => {
    await db.query(
      `INSERT INTO ai_agent_decisions (id, agent_type, proposal, confidence_score, reasoning, authority_level)
       VALUES ($1, $2, $3, $4, $5, 'A2')`,
      [uuid(), 'judge', JSON.stringify({ verdict: 'APPROVE', load_test: true }), 0.95, `Load test ${userId}-${opIdx}`]
    );
  });
}

/** 11. Mixed R/W Contention — 100 writers + 100 readers on same table */
async function testMixedContention(): Promise<SubsystemResult> {
  const users = await db.query('SELECT id FROM users LIMIT 1');
  const userId = users.rows.length > 0 ? users.rows[0].id : uuid();

  return runConcurrent('11. Mixed R/W Contention (200×3)', 200, 3, async (uId, opIdx) => {
    if (uId % 2 === 0) {
      await db.query(
        `INSERT INTO xp_events (id, user_id, amount, reason)
         VALUES ($1, $2, $3, $4)`,
        [uuid(), userId, 5, 'CONTENTION_TEST']
      );
    } else {
      await db.query(
        `SELECT id, amount, reason, created_at
         FROM xp_events
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
      );
    }
  });
}

/** 12. Complex Aggregation — 200 concurrent COUNT/AVG/MAX */
async function testComplexAggregation(): Promise<SubsystemResult> {
  return runConcurrent('12. Complex Aggregation (200×2)', 200, 2, async () => {
    await db.query(
      `SELECT
         COUNT(*) AS total_tasks,
         COUNT(*) FILTER (WHERE status = 'OPEN') AS open_tasks,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed_tasks,
         AVG(recommended_price) AS avg_price,
         MAX(recommended_price) AS max_price
       FROM tasks`
    );
  });
}

/** 13. Transaction Safety — 200 concurrent BEGIN/COMMIT cycles */
async function testTransactionSafety(): Promise<SubsystemResult> {
  return runConcurrent('13. Transaction Safety (200×2)', 200, 2, async (userId, opIdx) => {
    const pool = db.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ai_events (id, model_used, task_type, tokens_in, tokens_out, success, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [uuid(), 'txn-test', 'load_test', 50, 100, true]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

/** 14. XP Ledger Read Aggregation — user XP totals under contention */
async function testXPReadAggregation(): Promise<SubsystemResult> {
  return runConcurrent('14. XP Aggregation (200×2)', 200, 2, async () => {
    await db.query(
      `SELECT user_id, SUM(amount) AS total_xp, COUNT(*) AS event_count
       FROM xp_events
       GROUP BY user_id
       ORDER BY total_xp DESC
       LIMIT 10`
    );
  });
}

/** 15. Escrow + Task JOIN — complex cross-table query */
async function testEscrowTaskJoin(): Promise<SubsystemResult> {
  return runConcurrent('15. Escrow×Task JOIN (200×2)', 200, 2, async () => {
    await db.query(
      `SELECT e.id, e.amount, e.status AS escrow_status,
              t.title, t.status AS task_status, t.recommended_price
       FROM escrow e
       JOIN tasks t ON e.task_id = t.id
       ORDER BY e.created_at DESC
       LIMIT 10`
    );
  });
}

// ============================================================================
// CLEANUP
// ============================================================================
async function cleanup() {
  console.log('\n🧹 Cleaning up load test data...');
  try { await db.query("DELETE FROM xp_events WHERE reason IN ('LOAD_TEST', 'CONTENTION_TEST')"); } catch {}
  try { await db.query("DELETE FROM tasks WHERE status = 'LOAD_TEST'"); } catch {}
  try { await db.query("DELETE FROM ai_events WHERE task_type IN ('stress_test', 'load_test')"); } catch {}
  try { await db.query("DELETE FROM ai_agent_decisions WHERE reasoning LIKE 'Load test %'"); } catch {}
  console.log('✅ Cleanup complete');
}

// ============================================================================
// REPORT
// ============================================================================
function printReport(results: SubsystemResult[]) {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                      HustleXP Load Test Report — 200 Concurrent Users                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════════╝\n');

  const header = 'Subsystem'.padEnd(40) + 'Ops'.padStart(6) + '   OK'.padStart(6) + ' ERR'.padStart(5) +
    '   p50'.padStart(7) + '   p95'.padStart(7) + '   p99'.padStart(7) + '   Max'.padStart(7) + ' ops/s'.padStart(7) + '  Status';
  console.log(header);
  console.log('─'.repeat(112));

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const line = r.subsystem.padEnd(40) +
      String(r.totalOps).padStart(6) +
      String(r.successCount).padStart(6) +
      String(r.errorCount).padStart(5) +
      `${r.p50}ms`.padStart(7) +
      `${r.p95}ms`.padStart(7) +
      `${r.p99}ms`.padStart(7) +
      `${r.maxLatency}ms`.padStart(7) +
      String(r.throughput).padStart(7) +
      `  ${status}`;
    console.log(line);
    if (r.errors.length > 0) {
      console.log(`   └─ ${r.errors[0]}`);
      if (r.errors.length > 1) console.log(`   └─ ...and ${r.errors.length - 1} more`);
    }
  }

  const totalOps = results.reduce((sum, r) => sum + r.totalOps, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0);
  const allPassed = results.every(r => r.passed);
  const avgP50 = Math.round(results.reduce((sum, r) => sum + r.p50, 0) / results.length);
  const avgP95 = Math.round(results.reduce((sum, r) => sum + r.p95, 0) / results.length);
  const avgP99 = Math.round(results.reduce((sum, r) => sum + r.p99, 0) / results.length);
  const avgThroughput = Math.round(results.reduce((sum, r) => sum + r.throughput, 0) / results.length);

  console.log('─'.repeat(112));
  console.log(`\n📊 SUMMARY`);
  console.log(`   Total Operations:  ${totalOps.toLocaleString()}`);
  console.log(`   Total Errors:      ${totalErrors}`);
  console.log(`   Error Rate:        ${((totalErrors / totalOps) * 100).toFixed(2)}%`);
  console.log(`   Avg p50 Latency:   ${avgP50}ms`);
  console.log(`   Avg p95 Latency:   ${avgP95}ms`);
  console.log(`   Avg p99 Latency:   ${avgP99}ms`);
  console.log(`   Avg Throughput:    ${avgThroughput} ops/sec`);
  console.log(`\n${allPassed
    ? '🟢 ALL 15 SUBSYSTEMS PASSED — Backend handles 200+ concurrent users at peak load.'
    : '🔴 FAILURES DETECTED — See errors above.'}`);
}

// ============================================================================
// RUNNER
// ============================================================================
async function main() {
  await loadEnv();

  console.log('╔══════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║          HustleXP Backend Load Test — 200+ Concurrent Users × Max Difficulty                    ║');
  console.log('║          15 Subsystems • 200 Users • 6,800+ Operations                                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════════╝');

  const results: SubsystemResult[] = [];

  console.log('\n═══ Starting Load Tests ═══\n');

  console.log('▶ 1/15: Connection Pool Saturation...');
  results.push(await testConnectionPool());

  console.log('▶ 2/15: User Profile Reads...');
  results.push(await testUserProfileReads());

  console.log('▶ 3/15: Task Feed (JOIN)...');
  results.push(await testTaskFeed());

  console.log('▶ 4/15: Task Search (ILIKE)...');
  results.push(await testTaskSearch());

  console.log('▶ 5/15: Task Create + Read...');
  results.push(await testTaskLifecycle());

  console.log('▶ 6/15: Escrow Reads...');
  results.push(await testEscrowReads());

  console.log('▶ 7/15: XP Ledger Writes...');
  results.push(await testXPWrites());

  console.log('▶ 8/15: Notification Reads...');
  results.push(await testNotificationReads());

  console.log('▶ 9/15: AI Event Writes...');
  results.push(await testAIEventWrites());

  console.log('▶ 10/15: AI Decision Writes...');
  results.push(await testAIDecisionWrites());

  console.log('▶ 11/15: Mixed R/W Contention...');
  results.push(await testMixedContention());

  console.log('▶ 12/15: Complex Aggregation...');
  results.push(await testComplexAggregation());

  console.log('▶ 13/15: Transaction Safety...');
  results.push(await testTransactionSafety());

  console.log('▶ 14/15: XP Aggregation...');
  results.push(await testXPReadAggregation());

  console.log('▶ 15/15: Escrow×Task JOIN...');
  results.push(await testEscrowTaskJoin());

  printReport(results);
  await cleanup();

  const allPassed = results.every(r => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
