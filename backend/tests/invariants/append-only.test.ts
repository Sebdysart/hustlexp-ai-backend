/**
 * Append-Only Kill Tests: XP Ledger and Badges
 * 
 * PURPOSE: Prove that the database enforces append-only constraints
 *          These tests MUST FAIL if append-only enforcement is broken
 * 
 * INVARIANTS:
 * - XP ledger entries cannot be deleted (append-only)
 * - Badge entries cannot be deleted (append-only)
 * 
 * SPEC: PRODUCT_SPEC §2 (INV-5), §5, §6
 * ENFORCEMENT: schema.sql triggers `xp_ledger_delete_prevention`, `badge_delete_prevention`
 * ERROR CODES: HX102 (XP ledger), HX401 (Badges)
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
  
  // Verify connection
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
// XP LEDGER APPEND-ONLY TESTS (HX102)
// =============================================================================

describe('Append-Only: XP Ledger (HX102)', () => {
  
  it('MUST REJECT: DELETE from xp_ledger', async () => {
    const posterId = await createTestUser(pool, `test-poster-xp-1-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-xp-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Create an XP ledger entry (should succeed if escrow is RELEASED)
    const insertResult = await pool.query(
      `INSERT INTO xp_ledger (
        user_id, task_id, escrow_id, base_xp, effective_xp,
        user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award,
        reason
      )
      VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 2, 0, 'test')
      RETURNING id`,
      [workerId, taskId, escrowId]
    );
    
    const xpEntryId = insertResult.rows[0].id;
    
    // Attempt to DELETE the XP entry (should fail)
    await expect(
      pool.query('DELETE FROM xp_ledger WHERE id = $1', [xpEntryId])
    ).rejects.toMatchObject({
      code: 'HX102',
    });
  });

  it('MUST REJECT: DELETE all from xp_ledger', async () => {
    const posterId = await createTestUser(pool, `test-poster-xp-2-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-xp-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Create an XP ledger entry
    await pool.query(
      `INSERT INTO xp_ledger (
        user_id, task_id, escrow_id, base_xp, effective_xp,
        user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award,
        reason
      )
      VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 2, 0, 'test')`,
      [workerId, taskId, escrowId]
    );
    
    // Attempt to DELETE all XP entries (should fail)
    await expect(
      pool.query('DELETE FROM xp_ledger WHERE user_id = $1', [workerId])
    ).rejects.toMatchObject({
      code: 'HX102',
    });
  });

  it('MUST REJECT: TRUNCATE xp_ledger', async () => {
    // TRUNCATE should also be blocked by the trigger
    await expect(
      pool.query('TRUNCATE TABLE xp_ledger')
    ).rejects.toMatchObject({
      code: 'HX102',
    });
  });

  it('MUST SUCCEED: INSERT into xp_ledger (append-only means INSERT works)', async () => {
    const posterId = await createTestUser(pool, `test-poster-xp-3-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-xp-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // INSERT should succeed (append-only means you can add, just not delete)
    const result = await pool.query(
      `INSERT INTO xp_ledger (
        user_id, task_id, escrow_id, base_xp, effective_xp,
        user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award,
        reason
      )
      VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 2, 0, 'test')
      RETURNING id`,
      [workerId, taskId, escrowId]
    );
    
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBeDefined();
  });

  it('MUST SUCCEED: SELECT from xp_ledger (read operations allowed)', async () => {
    const posterId = await createTestUser(pool, `test-poster-xp-4-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-xp-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Create an XP entry
    await pool.query(
      `INSERT INTO xp_ledger (
        user_id, task_id, escrow_id, base_xp, effective_xp,
        user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award,
        reason
      )
      VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 2, 0, 'test')`,
      [workerId, taskId, escrowId]
    );
    
    // SELECT should succeed
    const result = await pool.query(
      'SELECT * FROM xp_ledger WHERE user_id = $1',
      [workerId]
    );
    
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// BADGES APPEND-ONLY TESTS (HX401)
// =============================================================================

describe('Append-Only: Badges (HX401)', () => {
  
  it('MUST REJECT: DELETE from badges', async () => {
    const userId = await createTestUser(pool, `test-user-badge-1-${Date.now()}@hustlexp.test`);
    
    // Create a badge entry
    const insertResult = await pool.query(
      `INSERT INTO badges (user_id, badge_type, badge_tier, awarded_at, reason)
       VALUES ($1, 'first_task', 1, NOW(), 'test')
       RETURNING id`,
      [userId]
    );
    
    const badgeId = insertResult.rows[0].id;
    
    // Attempt to DELETE the badge (should fail)
    await expect(
      pool.query('DELETE FROM badges WHERE id = $1', [badgeId])
    ).rejects.toMatchObject({
      code: 'HX401',
    });
  });

  it('MUST REJECT: DELETE all badges for a user', async () => {
    const userId = await createTestUser(pool, `test-user-badge-2-${Date.now()}@hustlexp.test`);
    
    // Create a badge entry
    await pool.query(
      `INSERT INTO badges (user_id, badge_type, badge_tier, awarded_at, reason)
       VALUES ($1, 'first_task', 1, NOW(), 'test')`,
      [userId]
    );
    
    // Attempt to DELETE all badges for user (should fail)
    await expect(
      pool.query('DELETE FROM badges WHERE user_id = $1', [userId])
    ).rejects.toMatchObject({
      code: 'HX401',
    });
  });

  it('MUST REJECT: TRUNCATE badges', async () => {
    // TRUNCATE should also be blocked by the trigger
    await expect(
      pool.query('TRUNCATE TABLE badges')
    ).rejects.toMatchObject({
      code: 'HX401',
    });
  });

  it('MUST SUCCEED: INSERT into badges (append-only means INSERT works)', async () => {
    const userId = await createTestUser(pool, `test-user-badge-3-${Date.now()}@hustlexp.test`);
    
    // INSERT should succeed (append-only means you can add, just not delete)
    const result = await pool.query(
      `INSERT INTO badges (user_id, badge_type, badge_tier, awarded_at, reason)
       VALUES ($1, 'first_task', 1, NOW(), 'test')
       RETURNING id`,
      [userId]
    );
    
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBeDefined();
  });

  it('MUST SUCCEED: SELECT from badges (read operations allowed)', async () => {
    const userId = await createTestUser(pool, `test-user-badge-4-${Date.now()}@hustlexp.test`);
    
    // Create a badge entry
    await pool.query(
      `INSERT INTO badges (user_id, badge_type, badge_tier, awarded_at, reason)
       VALUES ($1, 'first_task', 1, NOW(), 'test')`,
      [userId]
    );
    
    // SELECT should succeed
    const result = await pool.query(
      'SELECT * FROM badges WHERE user_id = $1',
      [userId]
    );
    
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('MUST REJECT: UPDATE badge (badges are append-only, no modifications allowed)', async () => {
    const userId = await createTestUser(pool, `test-user-badge-5-${Date.now()}@hustlexp.test`);
    
    // Create a badge entry
    const insertResult = await pool.query(
      `INSERT INTO badges (user_id, badge_type, badge_tier, awarded_at, reason)
       VALUES ($1, 'first_task', 1, NOW(), 'test')
       RETURNING id`,
      [userId]
    );
    
    const badgeId = insertResult.rows[0].id;
    
    // Attempt to UPDATE the badge (should fail - append-only means immutable)
    // Note: This may not have a specific trigger, but should be prevented by design
    // If UPDATE is allowed by schema, this test may need to be adjusted
    // For now, we'll test that DELETE fails, which is the critical constraint
    await expect(
      pool.query('UPDATE badges SET reason = $1 WHERE id = $2', ['modified', badgeId])
    ).rejects.toThrow(); // Either HX401 or a schema constraint
  });
});

// =============================================================================
// TRUST LEDGER APPEND-ONLY (if applicable)
// =============================================================================

describe('Append-Only: Trust Ledger (if applicable)', () => {
  
  it('MUST SUCCEED: INSERT into trust_ledger', async () => {
    const userId = await createTestUser(pool, `test-user-trust-1-${Date.now()}@hustlexp.test`);
    
    // INSERT should succeed
    const result = await pool.query(
      `INSERT INTO trust_ledger (user_id, old_tier, new_tier, changed_at, changed_by, reason)
       VALUES ($1, 1, 2, NOW(), 'system', 'test')
       RETURNING id`,
      [userId]
    );
    
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBeDefined();
  });

  // Note: Trust ledger may or may not have append-only enforcement
  // If it does, we should add DELETE rejection tests here
  // If it doesn't, this test just verifies INSERT works
});
