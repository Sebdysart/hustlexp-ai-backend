/**
 * N2.4 End-to-End Tests: Verification Resolution Flow
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Test the complete verification resolution flow end-to-end:
 * 1. Submit → Pending → Resolve → Recompute → Feed update
 * 2. Reject path (no eligibility granted)
 * 3. Expiry path (eligibility revoked)
 * 
 * ============================================================================
 * TEST SCENARIOS
 * ============================================================================
 * 
 * E2E-N2.4-1: Submit → Pending → Approve → Recompute → Capability granted
 * E2E-N2.4-2: Submit → Pending → Reject → Recompute → No capability granted
 * E2E-N2.4-3: Approve → Expire → Recompute → Capability revoked
 * 
 * Reference: Phase N2.4 — Verification Resolution (LOCKED)
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
  console.log('Connected to database for E2E tests');
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// =============================================================================
// E2E-N2.4-1: Submit → Pending → Approve → Recompute → Capability granted
// =============================================================================

describe('E2E-N2.4-1: Submit → Pending → Approve → Recompute → Capability granted', () => {
  
  it('MUST PASS: Complete flow grants capability after approval', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    // Set user trust tier
    await pool.query(
      `UPDATE users SET trust_tier = 'A' WHERE id = $1`,
      [userId]
    );
    
    // Step 1: Submit license verification (creates PENDING record)
    const submitResult = await pool.query(
      `INSERT INTO license_verifications 
       (user_id, trade_type, license_number, issuing_state, status, submitted_at)
       VALUES ($1, 'electrician', 'LIC123', 'WA', 'PENDING', NOW())
       RETURNING id, status`,
      [userId]
    );
    
    const verificationId = submitResult.rows[0].id;
    expect(submitResult.rows[0].status).toBe('PENDING');
    
    // Step 2: Verify no capability exists yet
    const beforeProfile = await pool.query(
      `SELECT * FROM capability_profiles WHERE user_id = $1`,
      [userId]
    );
    expect(beforeProfile.rows.length).toBe(0);
    
    // Step 3: Resolve to APPROVED (simulate admin action)
    await pool.query(
      `UPDATE license_verifications 
       SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by_system = true
       WHERE id = $1`,
      [verificationId]
    );
    
    // Step 4: Emit recompute trigger (simulate job queue)
    await pool.query(
      `INSERT INTO job_queue (id, type, payload, status, scheduled_at)
       VALUES ($1, 'recompute_capability', $2, 'pending', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        `recompute_${userId}_${Date.now()}`,
        JSON.stringify({
          userId,
          reason: 'VERIFICATION_RESOLVED',
          sourceVerificationId: verificationId,
        }),
      ]
    );
    
    // Step 5: Run recompute (simulate worker processing)
    const { recomputeCapabilityProfile } = await import('../../../src/services/CapabilityRecomputeService');
    await recomputeCapabilityProfile(userId, {
      reason: 'VERIFICATION_RESOLVED',
      sourceVerificationId: verificationId,
    });
    
    // Step 6: Verify capability granted
    const afterProfile = await pool.query(
      `SELECT * FROM capability_profiles WHERE user_id = $1`,
      [userId]
    );
    
    expect(afterProfile.rows.length).toBe(1);
    
    const verifiedTrades = await pool.query(
      `SELECT trade FROM verified_trades WHERE user_id = $1`,
      [userId]
    );
    
    expect(verifiedTrades.rows.length).toBeGreaterThan(0);
    expect(verifiedTrades.rows.some((r: any) => r.trade === 'electrician')).toBe(true);
  });
});

// =============================================================================
// E2E-N2.4-2: Submit → Pending → Reject → Recompute → No capability granted
// =============================================================================

describe('E2E-N2.4-2: Submit → Pending → Reject → Recompute → No capability granted', () => {
  
  it('MUST PASS: Rejected verification does not grant capability', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    await pool.query(
      `UPDATE users SET trust_tier = 'A' WHERE id = $1`,
      [userId]
    );
    
    // Step 1: Submit license verification
    const submitResult = await pool.query(
      `INSERT INTO license_verifications 
       (user_id, trade_type, license_number, issuing_state, status, submitted_at)
       VALUES ($1, 'electrician', 'LIC123', 'WA', 'PENDING', NOW())
       RETURNING id`,
      [userId]
    );
    
    const verificationId = submitResult.rows[0].id;
    
    // Step 2: Resolve to REJECTED
    await pool.query(
      `UPDATE license_verifications 
       SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by_system = true
       WHERE id = $1`,
      [verificationId]
    );
    
    // Step 3: Run recompute
    const { recomputeCapabilityProfile } = await import('../../../src/services/CapabilityRecomputeService');
    await recomputeCapabilityProfile(userId, {
      reason: 'VERIFICATION_RESOLVED',
      sourceVerificationId: verificationId,
    });
    
    // Step 4: Verify no capability granted (REJECTED verifications are not included)
    const verifiedTrades = await pool.query(
      `SELECT trade FROM verified_trades WHERE user_id = $1`,
      [userId]
    );
    
    // REJECTED verifications should not appear in verified_trades
    expect(verifiedTrades.rows.some((r: any) => r.trade === 'electrician')).toBe(false);
  });
});

// =============================================================================
// E2E-N2.4-3: Approve → Expire → Recompute → Capability revoked
// =============================================================================

describe('E2E-N2.4-3: Approve → Expire → Recompute → Capability revoked', () => {
  
  it('MUST PASS: Expired verification revokes capability', async () => {
    const userId = await createTestUser(pool, `test-user-${Date.now()}@hustlexp.test`);
    
    await pool.query(
      `UPDATE users SET trust_tier = 'A' WHERE id = $1`,
      [userId]
    );
    
    // Step 1: Create approved license with future expiration
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    
    const licenseResult = await pool.query(
      `INSERT INTO license_verifications 
       (user_id, trade_type, license_number, issuing_state, status, expiration_date, submitted_at)
       VALUES ($1, 'electrician', 'LIC123', 'WA', 'APPROVED', $2, NOW())
       RETURNING id`,
      [userId, futureDate]
    );
    
    const verificationId = licenseResult.rows[0].id;
    
    // Step 2: Initial recompute (grants capability)
    const { recomputeCapabilityProfile } = await import('../../../src/services/CapabilityRecomputeService');
    await recomputeCapabilityProfile(userId, { reason: 'TEST' });
    
    const initialTrades = await pool.query(
      `SELECT trade FROM verified_trades WHERE user_id = $1`,
      [userId]
    );
    
    expect(initialTrades.rows.some((r: any) => r.trade === 'electrician')).toBe(true);
    
    // Step 3: Expire the license
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);
    
    await pool.query(
      `UPDATE license_verifications 
       SET status = 'EXPIRED', expiration_date = $1
       WHERE id = $2`,
      [pastDate, verificationId]
    );
    
    // Step 4: Recompute after expiry
    await recomputeCapabilityProfile(userId, { reason: 'TEST' });
    
    // Step 5: Verify capability revoked
    const finalTrades = await pool.query(
      `SELECT trade FROM verified_trades WHERE user_id = $1`,
      [userId]
    );
    
    // Expired license should not appear in verified_trades
    expect(finalTrades.rows.some((r: any) => r.trade === 'electrician')).toBe(false);
  });
});
