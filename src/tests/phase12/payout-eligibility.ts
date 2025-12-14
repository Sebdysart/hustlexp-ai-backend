/**
 * PHASE 12C: PAYOUT ELIGIBILITY TESTS
 * 
 * Seattle Beta Required Tests:
 * 1. Proof requested → payout attempt → BLOCK
 * 2. Proof rejected → payout attempt → BLOCK
 * 3. Proof verified → payout → ALLOW
 * 4. Dispute opened after verification → BLOCK
 * 5. Admin override → ALLOW + audit
 * 
 * Run: npx tsx src/tests/phase12/payout-eligibility.ts
 */

import {
    PayoutEligibilityResolver,
    PayoutDecision,
    BlockReason,
    AdminOverride
} from '../../services/PayoutEligibilityResolver.js';
import { ProofService } from '../../services/proof/ProofService.js';
import { ProofFreezeService } from '../../services/proof/ProofFreezeService.js';
import { ProofType, ProofReason } from '../../services/proof/types.js';
import { KillSwitch } from '../../infra/KillSwitch.js';
import { neon } from '@neondatabase/serverless';
import { ulid } from 'ulidx';
import crypto from 'crypto';

const sql = neon(process.env.DATABASE_URL || '');

interface TestResult {
    name: string;
    passed: boolean;
    expected: string;
    actual: string;
    error?: string;
}

const results: TestResult[] = [];

// ============================================================
// TEST UTILITIES
// ============================================================

async function createTestTask(status: string = 'in_progress'): Promise<string> {
    const taskId = ulid();

    // Create minimal test user if not exists
    const testUserId = ulid();
    await sql`
        INSERT INTO users (id, firebase_uid, email, role, username, status)
        VALUES (${testUserId}::uuid, ${`test_${taskId}`}, ${`test_${taskId}@test.com`}, 'hustler', ${`testuser_${taskId.slice(-6)}`}, 'active')
        ON CONFLICT DO NOTHING
    `;

    // Create test task
    await sql`
        INSERT INTO tasks (id, title, description, status, client_id, price, category, location)
        VALUES (
            ${taskId}::uuid, 
            'Test Task for Eligibility', 
            'Testing payout eligibility resolver',
            ${status},
            ${testUserId}::uuid,
            50.00,
            'general',
            'Seattle, WA'
        )
    `;

    return taskId;
}

async function createMoneyStateLock(taskId: string, state: string = 'held'): Promise<void> {
    await sql`
        INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, version)
        VALUES (${taskId}::uuid, ${state}, ${['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN']}, 1)
        ON CONFLICT (task_id) DO UPDATE SET current_state = ${state}
    `;
}

async function createProofRequest(taskId: string): Promise<string> {
    const result = await ProofService.createRequest({
        taskId,
        proofType: ProofType.PHOTO,
        reason: ProofReason.TASK_COMPLETION,
        requestedBy: 'system',
        instructions: 'Submit completion photo',
        deadlineHours: 24
    });

    if (!result.success || !result.requestId) {
        throw new Error(`Failed to create proof request: ${result.error}`);
    }

    return result.requestId;
}

async function submitAndVerifyProof(taskId: string, requestId: string): Promise<void> {
    const fileHash = crypto.createHash('sha256').update(`test_${taskId}_${Date.now()}`).digest('hex');

    const submitResult = await ProofService.submitProof({
        requestId,
        submittedBy: 'test_user',
        fileUrl: `https://test.com/proof_${taskId}.jpg`,
        fileHash,
        mimeType: 'image/jpeg',
        fileSize: 1024,
        metadata: {
            exifPresent: true,
            resolution: { width: 1920, height: 1080 },
            fileFormat: 'jpeg'
        }
    });

    if (!submitResult.success || !submitResult.submissionId) {
        throw new Error(`Failed to submit proof: ${submitResult.error}`);
    }

    // Skip analysis, directly verify (simulating successful verification)
    await ProofService.finalizeProof(
        submitResult.submissionId,
        'verified',
        'test_system',
        'system'
    );

    // Update task freeze state
    await ProofFreezeService.setFreezeState(taskId, 'PROOF_VERIFIED');
}

async function rejectProof(taskId: string, requestId: string): Promise<void> {
    const fileHash = crypto.createHash('sha256').update(`test_rejected_${taskId}`).digest('hex');

    const submitResult = await ProofService.submitProof({
        requestId,
        submittedBy: 'test_user',
        fileUrl: `https://test.com/proof_${taskId}.jpg`,
        fileHash,
        mimeType: 'image/jpeg',
        fileSize: 1024,
        metadata: {
            exifPresent: true,
            resolution: { width: 1920, height: 1080 },
            fileFormat: 'jpeg'
        }
    });

    if (!submitResult.success || !submitResult.submissionId) {
        throw new Error(`Failed to submit proof: ${submitResult.error}`);
    }

    // Reject the proof
    await ProofService.finalizeProof(
        submitResult.submissionId,
        'rejected',
        'test_system',
        'system',
        'Invalid proof - test rejection'
    );
}

async function createDispute(taskId: string): Promise<void> {
    // Get a user for the dispute
    const [user] = await sql`SELECT id FROM users LIMIT 1` as any[];
    if (!user) {
        throw new Error('No user found for dispute');
    }

    await sql`
        INSERT INTO disputes (task_id, poster_id, hustler_id, reason, description, status)
        VALUES (
            ${taskId}::uuid, 
            ${user.id}, 
            ${user.id}, 
            'test_dispute', 
            'Test dispute for eligibility check',
            'pending'
        )
    `;
}

async function cleanup(taskId: string): Promise<void> {
    try {
        await sql`DELETE FROM payout_eligibility_log WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM disputes WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM proof_events WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM proof_submissions WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM proof_requests WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM money_state_lock WHERE task_id = ${taskId}::uuid`;
        await sql`DELETE FROM tasks WHERE id = ${taskId}::uuid`;
    } catch (e) {
        // Ignore cleanup errors
    }
}

// ============================================================
// TESTS
// ============================================================

async function test1_ProofRequestedBlocksPayout(): Promise<void> {
    const testName = 'TEST 1: Proof requested → payout attempt → BLOCK';
    console.log(`\n📋 Running: ${testName}`);

    let taskId = '';

    try {
        taskId = await createTestTask('in_progress');
        await createMoneyStateLock(taskId, 'held');

        // Create proof request (but don't submit)
        await createProofRequest(taskId);
        await ProofFreezeService.setFreezeState(taskId, 'AWAITING_PROOF');

        // Attempt payout eligibility check
        const result = await PayoutEligibilityResolver.resolve(taskId);

        const passed = result.decision === PayoutDecision.BLOCK;

        results.push({
            name: testName,
            passed,
            expected: PayoutDecision.BLOCK,
            actual: result.decision,
            error: passed ? undefined : `Expected BLOCK but got ${result.decision}: ${result.reason}`
        });

        console.log(passed ? '  ✅ PASSED' : `  ❌ FAILED: ${result.reason}`);
        console.log(`     Decision: ${result.decision}, Reason: ${result.blockReason}`);

    } catch (error: any) {
        results.push({
            name: testName,
            passed: false,
            expected: PayoutDecision.BLOCK,
            actual: 'ERROR',
            error: error.message
        });
        console.log(`  ❌ ERROR: ${error.message}`);
    } finally {
        if (taskId) await cleanup(taskId);
    }
}

async function test2_ProofRejectedBlocksPayout(): Promise<void> {
    const testName = 'TEST 2: Proof rejected → payout attempt → BLOCK';
    console.log(`\n📋 Running: ${testName}`);

    let taskId = '';

    try {
        taskId = await createTestTask('in_progress');
        await createMoneyStateLock(taskId, 'held');

        // Create and reject proof
        const requestId = await createProofRequest(taskId);
        await rejectProof(taskId, requestId);

        // Attempt payout eligibility check
        const result = await PayoutEligibilityResolver.resolve(taskId);

        // Rejected proof should escalate (not just block)
        const passed = result.decision === PayoutDecision.BLOCK || result.decision === PayoutDecision.ESCALATE;

        results.push({
            name: testName,
            passed,
            expected: 'BLOCK or ESCALATE',
            actual: result.decision,
            error: passed ? undefined : `Expected BLOCK/ESCALATE but got ${result.decision}`
        });

        console.log(passed ? '  ✅ PASSED' : `  ❌ FAILED: ${result.reason}`);
        console.log(`     Decision: ${result.decision}, BlockReason: ${result.blockReason}`);

    } catch (error: any) {
        results.push({
            name: testName,
            passed: false,
            expected: 'BLOCK or ESCALATE',
            actual: 'ERROR',
            error: error.message
        });
        console.log(`  ❌ ERROR: ${error.message}`);
    } finally {
        if (taskId) await cleanup(taskId);
    }
}

async function test3_ProofVerifiedAllowsPayout(): Promise<void> {
    const testName = 'TEST 3: Proof verified → payout → ALLOW';
    console.log(`\n📋 Running: ${testName}`);

    let taskId = '';

    try {
        taskId = await createTestTask('completed');
        await createMoneyStateLock(taskId, 'held');

        // Create and verify proof
        const requestId = await createProofRequest(taskId);
        await submitAndVerifyProof(taskId, requestId);

        // Attempt payout eligibility check
        const result = await PayoutEligibilityResolver.resolve(taskId);

        const passed = result.decision === PayoutDecision.ALLOW;

        results.push({
            name: testName,
            passed,
            expected: PayoutDecision.ALLOW,
            actual: result.decision,
            error: passed ? undefined : `Expected ALLOW but got ${result.decision}: ${result.reason}`
        });

        console.log(passed ? '  ✅ PASSED' : `  ❌ FAILED: ${result.reason}`);
        console.log(`     Decision: ${result.decision}, HasValidProof: ${result.details.hasValidProof}`);

    } catch (error: any) {
        results.push({
            name: testName,
            passed: false,
            expected: PayoutDecision.ALLOW,
            actual: 'ERROR',
            error: error.message
        });
        console.log(`  ❌ ERROR: ${error.message}`);
    } finally {
        if (taskId) await cleanup(taskId);
    }
}

async function test4_DisputeBlocksPayout(): Promise<void> {
    const testName = 'TEST 4: Dispute opened after verification → BLOCK';
    console.log(`\n📋 Running: ${testName}`);

    let taskId = '';

    try {
        taskId = await createTestTask('completed');
        await createMoneyStateLock(taskId, 'held');

        // Create and verify proof
        const requestId = await createProofRequest(taskId);
        await submitAndVerifyProof(taskId, requestId);

        // Now open a dispute
        await createDispute(taskId);

        // Attempt payout eligibility check
        const result = await PayoutEligibilityResolver.resolve(taskId);

        const passed = result.decision === PayoutDecision.BLOCK &&
            result.blockReason === BlockReason.DISPUTE_ACTIVE;

        results.push({
            name: testName,
            passed,
            expected: `${PayoutDecision.BLOCK} with ${BlockReason.DISPUTE_ACTIVE}`,
            actual: `${result.decision} with ${result.blockReason}`,
            error: passed ? undefined : `Expected BLOCK with DISPUTE_ACTIVE`
        });

        console.log(passed ? '  ✅ PASSED' : `  ❌ FAILED: ${result.reason}`);
        console.log(`     Decision: ${result.decision}, BlockReason: ${result.blockReason}`);

    } catch (error: any) {
        results.push({
            name: testName,
            passed: false,
            expected: `${PayoutDecision.BLOCK} with ${BlockReason.DISPUTE_ACTIVE}`,
            actual: 'ERROR',
            error: error.message
        });
        console.log(`  ❌ ERROR: ${error.message}`);
    } finally {
        if (taskId) await cleanup(taskId);
    }
}

async function test5_AdminOverrideAllowsPayout(): Promise<void> {
    const testName = 'TEST 5: Admin override → ALLOW + audit';
    console.log(`\n📋 Running: ${testName}`);

    let taskId = '';

    try {
        taskId = await createTestTask('completed');
        await createMoneyStateLock(taskId, 'held');

        // Create and verify proof
        const requestId = await createProofRequest(taskId);
        await submitAndVerifyProof(taskId, requestId);

        // Open a dispute to normally block
        await createDispute(taskId);

        // Verify it would be blocked without override
        const blockedResult = await PayoutEligibilityResolver.resolve(taskId);
        if (blockedResult.decision !== PayoutDecision.BLOCK) {
            throw new Error('Pre-condition failed: Expected BLOCK without override');
        }

        // Now use admin override
        const adminOverride: AdminOverride = {
            enabled: true,
            adminId: 'test_admin_123',
            reason: 'Seattle Beta - manual verification confirmed work completed'
        };

        const result = await PayoutEligibilityResolver.resolve(taskId, { adminOverride });

        // With admin override, should allow despite dispute
        const passed = result.decision === PayoutDecision.ALLOW &&
            result.details.adminOverride === true;

        // Verify audit log was created
        const [auditLog] = await sql`
            SELECT * FROM payout_eligibility_log 
            WHERE task_id = ${taskId}::uuid 
            ORDER BY evaluated_at DESC 
            LIMIT 1
        ` as any[];

        const auditLogged = !!auditLog && auditLog.decision === PayoutDecision.ALLOW;

        results.push({
            name: testName,
            passed: passed && auditLogged,
            expected: `${PayoutDecision.ALLOW} with audit log`,
            actual: `${result.decision}, audit: ${auditLogged}`,
            error: (passed && auditLogged) ? undefined :
                !passed ? 'Override did not result in ALLOW' : 'Audit log not found'
        });

        console.log((passed && auditLogged) ? '  ✅ PASSED' : `  ❌ FAILED`);
        console.log(`     Decision: ${result.decision}, AdminOverride: ${result.details.adminOverride}`);
        console.log(`     Audit Logged: ${auditLogged}`);

    } catch (error: any) {
        results.push({
            name: testName,
            passed: false,
            expected: `${PayoutDecision.ALLOW} with audit`,
            actual: 'ERROR',
            error: error.message
        });
        console.log(`  ❌ ERROR: ${error.message}`);
    } finally {
        if (taskId) await cleanup(taskId);
    }
}

// ============================================================
// MAIN TEST RUNNER
// ============================================================

async function runAllTests(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 12C: PAYOUT ELIGIBILITY CLOSURE TESTS');
    console.log('Seattle Beta Required Tests');
    console.log('='.repeat(60));

    // Ensure KillSwitch is not active for tests
    await KillSwitch.resolve();

    await test1_ProofRequestedBlocksPayout();
    await test2_ProofRejectedBlocksPayout();
    await test3_ProofVerifiedAllowsPayout();
    await test4_DisputeBlocksPayout();
    await test5_AdminOverrideAllowsPayout();

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    results.forEach(r => {
        const icon = r.passed ? '✅' : '❌';
        console.log(`${icon} ${r.name}`);
        if (!r.passed && r.error) {
            console.log(`   Error: ${r.error}`);
        }
    });

    console.log('\n' + '-'.repeat(60));
    console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

    if (failed === 0) {
        console.log('\n🎉 ALL TESTS PASSED - Phase 12C Verified');
        console.log('   Invariant confirmed: Money cannot move unless task is in provably safe state.');
    } else {
        console.log(`\n⚠️  ${failed} TEST(S) FAILED - Review required`);
        process.exit(1);
    }
}

// Run tests
runAllTests().catch(console.error);
