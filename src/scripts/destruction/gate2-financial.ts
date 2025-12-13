
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { neon } from '@neondatabase/serverless';

dotenv.config();

// Config
const PORT = 3006;
const BASE_URL = `http://localhost:${PORT}`;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Constants (must match gate2-prep.ts)
const DEV_POSTER_UID = '11111111-1111-1111-1111-111111111111';
const DEV_HUSTLER_UID = '22222222-2222-2222-2222-222222222222';

// ANSI Colors
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function log(msg: string, color: string = RESET) {
    console.log(`${color}${msg}${RESET}`);
}

async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth() {
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`${BASE_URL}/health`);
            if (res.ok) return true;
        } catch (e) { }
        await wait(500);
    }
    return false;
}

async function resolveIds() {
    if (!DATABASE_URL) throw new Error('DATABASE_URL missing');
    const sql = neon(DATABASE_URL);

    // Fetch Internal UUIDs derived from the specific Firebase UIDs used in prep
    const users = await sql`SELECT id, firebase_uid, role FROM users WHERE firebase_uid IN (${DEV_POSTER_UID}, ${DEV_HUSTLER_UID})`;

    const poster = users.find(u => u.firebase_uid === DEV_POSTER_UID);
    const hustler = users.find(u => u.firebase_uid === DEV_HUSTLER_UID);

    if (!poster || !hustler) throw new Error('Test users not found in DB. Run gate2-prep.ts first.');

    return { posterId: poster.id, hustlerId: hustler.id, sql };
}

async function runTest(name: string, fn: () => Promise<boolean>) {
    process.stdout.write(`TEST: ${name.padEnd(50)}`);
    try {
        const pass = await fn();
        if (pass) {
            console.log(`${GREEN}PASS${RESET}`);
            return true;
        } else {
            console.log(`${RED}FAIL${RESET}`);
            return false;
        }
    } catch (e: any) {
        console.log(`${RED}ERROR: ${e.message}${RESET}`);
        return false;
    }
}

async function financialDestructionSuite() {
    log('\n=== GATE 2B: FINANCIAL DESTRUCTION SUITE (REMEDIATION RUN) ===\n', CYAN);

    if (!STRIPE_KEY || !STRIPE_KEY.startsWith('sk_test_')) {
        log('CRITICAL: Valid Stripe Test Key required in .env!', RED);
        process.exit(1);
    }

    // Resolve IDs first
    let ids: { posterId: string, hustlerId: string, sql: any } | null = null;
    try {
        ids = await resolveIds();
        log(`Resolved IDs: Poster=${ids.posterId}, Hustler=${ids.hustlerId}`, CYAN);
    } catch (e: any) {
        log(`DB Error: ${e.message}`, RED);
        process.exit(1);
    }

    // 1. SPAWN SERVER
    const serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
        env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
        cwd: process.cwd(),
        stdio: 'pipe'
    });

    let serverOutput = '';
    serverProcess.stdout.on('data', d => serverOutput += d.toString());
    serverProcess.stderr.on('data', d => serverOutput += d.toString());

    const killServer = () => { if (!serverProcess.killed) serverProcess.kill(); };
    process.on('exit', killServer);
    process.on('SIGINT', killServer);

    try {
        if (!await waitForHealth()) {
            log('Server failed to start!', RED);
            console.log(serverOutput);
            return;
        }

        // 2. SETUP DATA
        log('--- Setting up Financial Test Data ---', YELLOW);

        // Create Task
        const taskRes = await fetch(`${BASE_URL}/ai/confirm-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-role': 'poster' }, // Bypass Auth
            body: JSON.stringify({
                userId: DEV_POSTER_UID, // Endpoint resolves this to internal ID
                taskDraft: {
                    title: 'Financial Death Task (Remediation)',
                    description: 'To be destroyed',
                    category: 'cleaning',
                    recommendedPrice: 50,
                    flags: []
                }
            })
        });
        const taskData = await taskRes.json() as any;
        const taskId = taskData.task?.id;
        if (!taskId) throw new Error('Failed to create task');

        log(`Task Created: ${taskId}`, CYAN);

        // MANUALLY ASSIGN HUSTLER (Required for Approval Endpoint)
        // Using neon sql client directly
        // NOTE: In production, acceptance flow does this. In test, we force it to isolate payout logic.
        await ids.sql`UPDATE tasks SET assigned_hustler_id = ${ids.hustlerId}, status = 'assigned' WHERE id = ${taskId}`;
        log(`Task Assigned to Hustler: ${ids.hustlerId}`, CYAN);

        // 3. Create Escrow (With Idempotency Key & Internal UUIDs)
        const escrowRes = await fetch(`${BASE_URL}/api/escrow/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-test-role': 'poster',
                'x-test-db-uid': ids.posterId, // Inject Internal UUID for Strict Middleware
                'x-idempotency-key': `test-escrow-${Date.now()}`
            },
            body: JSON.stringify({
                taskId: taskId,
                hustlerId: ids.hustlerId, // Internal UUID
                amount: 50,
                paymentMethodId: 'pm_card_visa' // Test card
            })
        });

        if (!escrowRes.ok) {
            const err = await escrowRes.text();
            console.log('Escrow Failed:', err);
        } else {
            log('Escrow Created.', CYAN);
        }

        // 4. RUN TESTS
        let passed = 0;
        let total = 0;

        // TEST 1: NEGATIVE TIP (Schema Validation)
        total++;
        passed += (await runTest('Negative Tip Attack', async () => {
            const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/approve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-test-role': 'poster',
                    'x-test-db-uid': ids.posterId,
                    'x-idempotency-key': `test-neg-${Date.now()}`
                },
                body: JSON.stringify({ tip: -100 })
            });
            // Should fail validation (400)
            return res.status === 400;
        })) ? 1 : 0;

        // TEST 2: UNAUTHORIZED RELEASE (Hustler trying to approve)
        total++;
        passed += (await runTest('Unauthorized Release (Hustler)', async () => {
            const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/approve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-test-role': 'hustler',
                    'x-test-db-uid': ids.hustlerId, // Inject Hustler DB ID
                    'x-idempotency-key': `test-auth-${Date.now()}`
                }, // Hustler cannot approve
                body: JSON.stringify({})
            });
            // Should be 403 Forbidden
            return res.status === 403;
        })) ? 1 : 0;

        // TEST 3: DOUBLE PAYOUT RACE (Concurrency)
        // Only run if escrow exists (otherwise payout logic might fail early)
        if (escrowRes.ok) {
            total++;
            passed += (await runTest('Double Payout Race Condition', async () => {
                // Fire 5 requests at once with DISTINCT idempotency keys to force concurrency logic
                // If we used same key, the Idempotency Middleware would just return cached result.
                // We want to test the DB Lock / State Logic.
                const requests = Array(5).fill(0).map((_, i) =>
                    fetch(`${BASE_URL}/api/tasks/${taskId}/approve`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-test-role': 'poster',
                            'x-test-db-uid': ids.posterId, // Inject Internal UUID
                            'x-idempotency-key': `test-race-${Date.now()}-${i}`
                        },
                        body: JSON.stringify({})
                    })
                );

                const responses = await Promise.all(requests);
                const successes = responses.filter(r => r.ok).length;

                // Only 1 should succeed
                if (successes === 1) return true;

                if (successes === 0) {
                    console.log('0 Successes (Expected 1) - Check if Hustler has Stripe Account connected?');
                    const failures = responses.filter(r => !r.ok);
                    if (failures.length > 0) {
                        const txt = await failures[0].text();
                        console.log(`Failure Reason: ${failures[0].status} - ${txt}`);
                    }
                }

                return false;
            })) ? 1 : 0;
        } else {
            // Mark skipped/failed
            total++;
            console.log(`${YELLOW}SKIPPED Race Condition (Escrow failed)${RESET}`);
        }

        // TEST 4: WEBHOOK REPLAY (Testing Crash Integrity)
        total++;
        passed += (await runTest('Webhook Replay Attack (Crash Check)', async () => {
            const eventId = `evt_test_${Date.now()}`;
            const payload = {
                id: eventId,
                type: 'payout.paid',
                data: { object: { metadata: { taskId } } }
            };

            const sendWebhook = async () => {
                try {
                    return await fetch(`${BASE_URL}/webhooks/stripe`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } catch (e: any) {
                    if (e.cause?.code === 'ECONNRESET') {
                        return { ok: false, status: 0, reason: 'Server Crashed (ECONNRESET)' };
                    }
                    return { ok: false, status: 0, reason: String(e) };
                }
            };

            // Send First
            const res1 = await sendWebhook();

            // Send Second (Replay)
            const res2 = await sendWebhook();

            // Check viability
            if ((res1 as any).reason) console.log(`Webhook 1 Error: ${(res1 as any).reason}`);
            if ((res2 as any).reason) console.log(`Webhook 2 Error: ${(res2 as any).reason}`);

            // Both should be accepted (200) or handled.
            // Check if server survived
            const health = await waitForHealth();
            if (!health) {
                console.log('Server Died after Webhook Test');
                return false;
            }

            return res1.ok && res2.ok;
        })) ? 1 : 0;

        log('\n=== RESULTS ===', CYAN);
        log(`PASSED: ${passed}/${total}`, passed === total ? GREEN : RED);

        if (passed === total) {
            log('\nGATE 2B (FINANCIAL) CERTIFIED.', GREEN);
        } else {
            log('\nGATE 2B FAILED.', RED);
            console.log('\n--- SERVER LOGS TAIL ---');
            console.log(serverOutput.slice(-3000));
        }

    } finally {
        killServer();
    }
}

financialDestructionSuite();
