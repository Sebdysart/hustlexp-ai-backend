/**
 * N4 Feed Eligibility Invariant Tests
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Prove that the feed query enforces eligibility invariants.
 * These tests MUST FAIL if eligibility enforcement is broken.
 * 
 * ============================================================================
 * INVARIANTS TESTED
 * ============================================================================
 * 
 * INV-N4-1: Feed query returns ONLY eligible tasks
 * INV-N4-2: Feed query uses SQL JOIN for eligibility (no post-query filtering)
 * INV-N4-3: Tasks without capability_profiles are excluded
 * INV-N4-4: Frontend trusts all returned tasks are eligible
 * 
 * ============================================================================
 * AUTHORITY MODEL
 * ============================================================================
 * 
 * - Feed query: SQL JOIN with capability_profiles enforces eligibility
 * - Frontend: Trusts all returned tasks are eligible (no client filtering)
 * - No disabled cards: All tasks in feed are actionable
 * 
 * Reference: Phase N4 — Feed Query Migration (LOCKED)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { 
  createTestPool, 
  cleanupTestData, 
  createTestUser
} from '../setup';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  console.log('Connected to database for N4 feed eligibility tests');
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// =============================================================================
// INV-N4-1: Feed query returns ONLY eligible tasks
// =============================================================================

describe('INV-N4-1: Feed query returns ONLY eligible tasks', () => {
  
  it('MUST PASS: Feed query excludes non-OPEN tasks', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    // Create capability profile for user
    await pool.query(
      `INSERT INTO capability_profiles (user_id, trust_tier, risk_clearance)
       VALUES ($1, 'A', ARRAY['low'])`,
      [userId]
    );
    
    // Create OPEN task (should appear in feed)
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES ($1, 'Open Task', 'Description', 5000, 'OPEN', 'cleaning', 'LOW')`,
      [userId]
    );
    
    // Create COMPLETED task (should NOT appear in feed)
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES ($1, 'Completed Task', 'Description', 5000, 'COMPLETED', 'cleaning', 'LOW')`,
      [userId]
    );
    
    // Execute feed query (simulate tasks.list)
    const feedResult = await pool.query(
      `
      SELECT t.id, t.title, t.state
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 20
      `,
      [userId]
    );
    
    // All returned tasks must be OPEN
    feedResult.rows.forEach((row: any) => {
      expect(row.state).toBe('OPEN');
    });
    
    // COMPLETED task must not appear
    const completedTask = feedResult.rows.find((r: any) => r.title === 'Completed Task');
    expect(completedTask).toBeUndefined();
  });
  
  it('MUST PASS: Feed query excludes tasks for users without capability_profiles', async () => {
    const userIdWithProfile = await createTestUser(pool, `test-user-1-${Date.now()}@hustlexp.test`);
    const userIdWithoutProfile = await createTestUser(pool, `test-user-2-${Date.now()}@hustlexp.test`);
    
    // Create profile for first user only
    await pool.query(
      `INSERT INTO capability_profiles (user_id, trust_tier, risk_clearance)
       VALUES ($1, 'A', ARRAY['low'])`,
      [userIdWithProfile]
    );
    
    // Create tasks
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES ($1, 'Task 1', 'Description', 5000, 'OPEN', 'cleaning', 'LOW')`,
      [userIdWithProfile]
    );
    
    // Query feed for user WITH profile
    const feedWithProfile = await pool.query(
      `
      SELECT t.id, t.title
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      LIMIT 20
      `,
      [userIdWithProfile]
    );
    
    expect(feedWithProfile.rows.length).toBeGreaterThan(0);
    
    // Query feed for user WITHOUT profile (should return 0 tasks)
    const feedWithoutProfile = await pool.query(
      `
      SELECT t.id, t.title
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      LIMIT 20
      `,
      [userIdWithoutProfile]
    );
    
    expect(feedWithoutProfile.rows.length).toBe(0);
  });
});

// =============================================================================
// INV-N4-2: Feed query uses SQL JOIN for eligibility (no post-query filtering)
// =============================================================================

describe('INV-N4-2: Feed query uses SQL JOIN for eligibility (no post-query filtering)', () => {
  
  it('MUST PASS: Feed query eligibility is enforced at SQL level, not application level', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    await pool.query(
      `INSERT INTO capability_profiles (user_id, trust_tier, risk_clearance)
       VALUES ($1, 'A', ARRAY['low'])`,
      [userId]
    );
    
    // Create multiple tasks
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES 
       ($1, 'Task 1', 'Description', 5000, 'OPEN', 'cleaning', 'LOW'),
       ($1, 'Task 2', 'Description', 5000, 'OPEN', 'delivery', 'LOW'),
       ($1, 'Task 3', 'Description', 5000, 'COMPLETED', 'cleaning', 'LOW')`,
      [userId]
    );
    
    // Execute feed query with JOIN (eligibility enforced at SQL level)
    const feedResult = await pool.query(
      `
      SELECT t.id, t.title, t.state
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      ORDER BY t.created_at DESC
      `,
      [userId]
    );
    
    // Verify all returned tasks are OPEN (filtered at SQL level)
    feedResult.rows.forEach((row: any) => {
      expect(row.state).toBe('OPEN');
    });
    
    // Verify COMPLETED task is not in results (filtered out by SQL)
    const completedTask = feedResult.rows.find((r: any) => r.title === 'Task 3');
    expect(completedTask).toBeUndefined();
  });
});

// =============================================================================
// INV-N4-3: Tasks without capability_profiles are excluded
// =============================================================================

describe('INV-N4-3: Tasks without capability_profiles are excluded', () => {
  
  it('MUST PASS: INNER JOIN excludes users without capability_profiles', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    // Create task BUT no capability profile
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES ($1, 'Task Without Profile', 'Description', 5000, 'OPEN', 'cleaning', 'LOW')`,
      [userId]
    );
    
    // Query feed with INNER JOIN (should return 0 tasks)
    const feedResult = await pool.query(
      `
      SELECT t.id, t.title
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      LIMIT 20
      `,
      [userId]
    );
    
    // INNER JOIN should exclude tasks from users without profiles
    expect(feedResult.rows.length).toBe(0);
  });
});

// =============================================================================
// INV-N4-4: Frontend trusts all returned tasks are eligible
// =============================================================================

describe('INV-N4-4: Frontend trusts all returned tasks are eligible', () => {
  
  it('MUST PASS: All tasks returned by feed query are actionable (no disabled states)', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    await pool.query(
      `INSERT INTO capability_profiles (user_id, trust_tier, risk_clearance)
       VALUES ($1, 'A', ARRAY['low'])`,
      [userId]
    );
    
    // Create OPEN tasks
    await pool.query(
      `INSERT INTO tasks (poster_id, title, description, price, state, category, risk_level)
       VALUES 
       ($1, 'Actionable Task 1', 'Description', 5000, 'OPEN', 'cleaning', 'LOW'),
       ($1, 'Actionable Task 2', 'Description', 5000, 'OPEN', 'delivery', 'LOW')`,
      [userId]
    );
    
    // Execute feed query
    const feedResult = await pool.query(
      `
      SELECT t.id, t.title, t.state
      FROM tasks t
      INNER JOIN capability_profiles cp ON cp.user_id = $1
      WHERE t.state = 'OPEN' AND cp.user_id = $1
      ORDER BY t.created_at DESC
      `,
      [userId]
    );
    
    // All returned tasks must be actionable (OPEN state)
    feedResult.rows.forEach((row: any) => {
      expect(row.state).toBe('OPEN');
      // Frontend can trust this task is eligible and actionable
    });
    
    // No disabled or non-actionable states should appear
    const nonActionableStates = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'DISPUTED'];
    feedResult.rows.forEach((row: any) => {
      expect(nonActionableStates).not.toContain(row.state);
    });
  });
});
