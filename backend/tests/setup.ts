/**
 * HustleXP Test Setup
 * 
 * Shared configuration for invariant tests using Neon PostgreSQL
 */

import pg from 'pg';

const { Pool } = pg;

// Use environment variable or default Neon connection
const DATABASE_URL = process.env.DATABASE_URL || 
  'postgresql://neondb_owner:REDACTED_NEON_PASSWORD_1@REDACTED_NEON_HOST_1.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

export function createTestPool(): pg.Pool {
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

// Generate unique test run ID to avoid conflicts between test runs
const TEST_RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * Get test email with unique run ID to avoid conflicts
 */
export function getTestEmail(name: string): string {
  return `test-${TEST_RUN_ID}-${name}@hustlexp.test`;
}

/**
 * Clean up test data from this specific test run
 * Note: Cannot delete from append-only tables (xp_ledger, badges) due to triggers
 * Using unique TEST_RUN_ID ensures no conflicts between runs
 */
export async function cleanupTestData(pool: pg.Pool): Promise<void> {
  const pattern = `test-${TEST_RUN_ID}-%@hustlexp.test`;
  
  // Delete in order that respects foreign keys
  // Skip xp_ledger and badges - they're append-only and uniqueness is guaranteed by TEST_RUN_ID
  await pool.query('DELETE FROM trust_ledger WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [pattern]);
  await pool.query('DELETE FROM proof_photos WHERE proof_id IN (SELECT p.id FROM proofs p JOIN tasks t ON p.task_id = t.id JOIN users u ON t.poster_id = u.id WHERE u.email LIKE $1)', [pattern]);
  await pool.query('DELETE FROM proofs WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM escrows WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM disputes WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1)', [pattern]);
  // Don't delete users if they have xp_ledger/badges entries (FK constraint)
  // await pool.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
}

/**
 * Create a test user
 */
export async function createTestUser(pool: pg.Pool, email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, full_name, default_mode)
     VALUES ($1, $2, 'worker')
     RETURNING id`,
    [email, 'Test User']
  );
  return result.rows[0].id;
}

/**
 * Create a test task
 */
export async function createTestTask(
  pool: pg.Pool, 
  posterId: string, 
  state: string = 'OPEN',
  requiresProof: boolean = false
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO tasks (poster_id, title, description, price, state, requires_proof)
     VALUES ($1, 'Test Task', 'Test Description', 5000, $2, $3)
     RETURNING id`,
    [posterId, state, requiresProof]
  );
  return result.rows[0].id;
}

/**
 * Create a test escrow
 */
export async function createTestEscrow(
  pool: pg.Pool, 
  taskId: string, 
  state: string = 'PENDING'
): Promise<string> {
  // REFUND_PARTIAL state requires refund_amount + release_amount = amount
  if (state === 'REFUND_PARTIAL') {
    const result = await pool.query(
      `INSERT INTO escrows (task_id, amount, state, refund_amount, release_amount)
       VALUES ($1, 5000, $2, 2500, 2500)
       RETURNING id`,
      [taskId, state]
    );
    return result.rows[0].id;
  }
  
  const result = await pool.query(
    `INSERT INTO escrows (task_id, amount, state)
     VALUES ($1, 5000, $2)
     RETURNING id`,
    [taskId, state]
  );
  return result.rows[0].id;
}

/**
 * Create a test proof
 */
export async function createTestProof(
  pool: pg.Pool,
  taskId: string,
  submitterId: string,
  state: string = 'PENDING'
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO proofs (task_id, submitter_id, state, description)
     VALUES ($1, $2, $3, 'Test proof description')
     RETURNING id`,
    [taskId, submitterId, state]
  );
  return result.rows[0].id;
}

/**
 * Update escrow state directly (for testing)
 */
export async function setEscrowState(
  pool: pg.Pool,
  escrowId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE escrows SET state = $1 WHERE id = $2`,
    [state, escrowId]
  );
}

/**
 * Update task state directly (for testing)
 */
export async function setTaskState(
  pool: pg.Pool,
  taskId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE tasks SET state = $1 WHERE id = $2`,
    [state, taskId]
  );
}

/**
 * Update proof state directly (for testing)
 */
export async function setProofState(
  pool: pg.Pool,
  proofId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE proofs SET state = $1 WHERE id = $2`,
    [state, proofId]
  );
}
