
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transaction, safeSql as sql } from '../src/db/index.js';
import { FakeStripe } from '../src/tests/fakes/FakeStripe.js';
import { SagaRecoverySweeper } from '../src/cron/SagaRecoverySweeper.js';
import { StripeMoneyEngine } from '../src/services/StripeMoneyEngine.js';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulidx';

/**
 * STRICT MONEY FLOW TESTS (Phase Ω-ACT)
 * 
 * Rules:
 * 1. NO SKIPS.
 * 2. Deterministic FakeStripe.
 * 3. Exact ledger + Stripe simulation assertions.
 */

describe('Critical Money Flow (Strict Fake)', () => {
    const trackedIds = new Set<string>();

    const getTestId = () => {
        const id = randomUUID();
        trackedIds.add(id);
        return id;
    };

    beforeEach(() => {
        FakeStripe.reset();
    });

    afterEach(async () => {
        if (trackedIds.size > 0) {
            const ids = Array.from(trackedIds);
            await transaction(async (tx) => {
                // Delete dependants first
                await tx`DELETE FROM money_events_audit WHERE task_id = ANY(${ids}::uuid[])`;
                await tx`DELETE FROM money_state_lock WHERE task_id = ANY(${ids}::uuid[])`;
                await tx`DELETE FROM ledger_transactions WHERE metadata->>'taskId' = ANY(${ids}::text[])`;
                await tx`DELETE FROM tasks WHERE id = ANY(${ids}::uuid[])`;
                // Now clean users (if their IDs are in trackedIds)
                await tx`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
            });
            trackedIds.clear();
        }
    });



    describe('Stripe Fake Integrity', () => {
        it('should require idempotency key (STRICT MODE)', async () => {
            const fake = new FakeStripe();
            await expect(fake.transfers.create({
                amount: 1000,
                currency: 'usd',
                destination: 'acct_test_123'
            })).rejects.toThrow('missing idempotency key');
        });

        it('should enforce idempotency atomically', async () => {
            const fake = new FakeStripe();
            const key = 'idem_test_1';

            const t1 = await fake.transfers.create({
                amount: 1000,
                currency: 'usd',
                destination: 'acct_test_123'
            }, { idempotencyKey: key });

            const t2 = await fake.transfers.create({
                amount: 1000,
                currency: 'usd',
                destination: 'acct_test_123'
            }, { idempotencyKey: key });

            expect(t1.id).toBe(t2.id);
            expect(FakeStripe.state.transfers.size).toBe(1);
            expect(FakeStripe.state.balances.get('acct_test_123')).toBe(1000);
        });

        it('should simulate timeout and recover', async () => {
            FakeStripe.failNext('timeout');
            const fake = new FakeStripe();
            const key = 'idem_retry_1';

            // 1. Fail
            await expect(fake.transfers.create({
                amount: 500,
                currency: 'usd',
                destination: 'acct_test_999'
            }, { idempotencyKey: key })).rejects.toThrow('StripeConnectionError');

            // 1b. Verify no transfer recorded
            expect(FakeStripe.state.balances.get('acct_test_999')).toBeUndefined();

            // 2. Retry matches
            const t2 = await fake.transfers.create({
                amount: 500,
                currency: 'usd',
                destination: 'acct_test_999'
            }, { idempotencyKey: key });

            expect(t2.amount).toBe(500);
            expect(FakeStripe.state.transfers.size).toBe(1);
        });
    });

    describe('Saga Recovery with Fake Stripe', () => {
        it('should recover stuck executing saga by committing when Stripe succeeds', async () => {
            const taskId = getTestId();
            const transferId = 'tr_fake_existing';
            const fake = new FakeStripe();
            const userId = getTestId();

            // 1. Setup Logic: Task "stuck" in executing
            await transaction(async (tx) => {
                // Seed User/Task (Required by constraints)
                await tx`
                    INSERT INTO users (id, email, username, firebase_uid)
                    VALUES (${userId}, ${'test-' + userId + '@example.com'}, ${'User ' + userId}, ${'fb_' + userId})
                `;
                await tx`
                    INSERT INTO tasks (id, client_id, created_by, title, description, category, price, status, city, address, latitude, longitude, deadline, xp_reward)
                    VALUES (${taskId}, ${userId}, ${userId}, 'Test Payout Task', 'Test Description', 'moving', 50.00, 'in_progress', 'Seattle', '123 Test St', 47.6, -122.3, NOW() + INTERVAL '1 day', 100)
                 `;

                await tx`
                    INSERT INTO money_state_lock (task_id, current_state, stripe_transfer_id, last_transition_at)
                    VALUES (${taskId}, 'executing_payout', ${transferId}, NOW() - INTERVAL '20 minutes')
                `;

                await tx`
                    INSERT INTO money_events_audit (task_id, event_id, event_type, raw_context)
                    VALUES (${taskId}, ${ulid()}, 'executing_payout', ${JSON.stringify({ transferId })})
                `;
            });

            // 2. Setup Stripe State: Transfer actually happened
            FakeStripe.state.transfers.set(transferId, {
                id: transferId,
                object: 'transfer',
                amount: 1000,
                amount_reversed: 0,
                balance_transaction: 'txn_123',
                created: Date.now(),
                currency: 'usd',
                description: null,
                destination: 'acct_hustler',
                destination_payment: 'py_123',
                livemode: false,
                metadata: {},
                reversals: { object: 'list', data: [], has_more: false, total_count: 0, url: '' },
                reversed: false,
                source_transaction: null,
                source_type: 'card',
                transfer_group: null,
                status: 'paid'
            } as any);

            // 3. Run Sweeper with FAKE
            const results = await SagaRecoverySweeper.run({ stripeClient: fake });

            // 4. Assert
            const result = results.find(r => r.taskId === taskId);
            expect(result).toBeDefined();
            expect(result?.action).toBe('committed');
        });

        it('should recover stuck saga by failing when Stripe confirms failure', async () => {
            const taskId = getTestId();
            const transferId = 'tr_fake_reversed';
            const fake = new FakeStripe();
            const userId = getTestId();

            // 1. Setup: Task stuck
            await transaction(async (tx) => {
                await tx`
                    INSERT INTO users (id, email, username, firebase_uid)
                    VALUES (${userId}, ${'test-' + userId + '@example.com'}, ${'User ' + userId}, ${'fb_' + userId})
                `;
                await tx`
                    INSERT INTO tasks (id, client_id, created_by, title, description, category, price, status, city, address, latitude, longitude, deadline, xp_reward)
                    VALUES (${taskId}, ${userId}, ${userId}, 'Test Payout Task', 'Test Description', 'moving', 50.00, 'in_progress', 'Seattle', '123 Test St', 47.6, -122.3, NOW() + INTERVAL '1 day', 100)
                 `;

                await tx`
                     INSERT INTO money_state_lock (task_id, current_state, stripe_transfer_id, last_transition_at)
                     VALUES (${taskId}, 'executing_payout', ${transferId}, NOW() - INTERVAL '30 minutes')
                 `;
                await tx`
                     INSERT INTO money_events_audit (task_id, event_id, event_type, raw_context)
                     VALUES (${taskId}, ${ulid()}, 'executing_payout', ${JSON.stringify({ transferId })})
                 `;
            });

            // 2. Stripe State: Transfer was REVERSED
            FakeStripe.state.transfers.set(transferId, {
                id: transferId,
                object: 'transfer',
                amount: 1000,
                amount_reversed: 1000,
                balance_transaction: 'txn_123',
                created: Date.now(),
                currency: 'usd',
                destination: 'acct_hustler',
                livemode: false,
                metadata: {},
                reversals: { object: 'list', data: [], has_more: false, total_count: 0, url: '' },
                reversed: true, // KEY
                status: 'reversed'
            } as any);

            // 3. Run Sweeper
            const results = await SagaRecoverySweeper.run({ stripeClient: fake });

            // 4. Assert
            const result = results.find(r => r.taskId === taskId);
            expect(result?.action).toBe('failed');
        });
    });

    describe('StripeMoneyEngine Payout Flow (End-to-End)', () => {
        it('should execute payout successfully using FakeStripe', async () => {
            const taskId = getTestId();
            const userId = getTestId();
            const fake = new FakeStripe();
            const hustlerId = 'acct_hustler_e2e';

            // 1. Setup: Held state + Dependencies
            await transaction(async (tx) => {
                // Create User
                await tx`
                    INSERT INTO users (id, email, username, firebase_uid)
                    VALUES (${userId}, ${'test-' + userId + '@example.com'}, ${'User ' + userId}, ${'fb_' + userId})
                 `;

                // Create Task
                await tx`
                    INSERT INTO tasks (id, client_id, created_by, title, description, category, price, status, city, address, latitude, longitude, deadline, xp_reward)
                    VALUES (${taskId}, ${userId}, ${userId}, 'Test Payout Task', 'Test Description', 'moving', 50.00, 'in_progress', 'Seattle', '123 Test St', 47.6, -122.3, NOW() + INTERVAL '1 day', 100)
                 `;

                await tx`
                    INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, last_transition_at, stripe_payment_intent_id, stripe_charge_id)
                    VALUES (${taskId}, 'held', ${['RELEASE_PAYOUT']}, NOW() - INTERVAL '1 hour', 'pi_fake_123', 'ch_fake_123')
                 `;
            });

            try {
                // 2. Execute Release
                await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', {
                    payoutAmountCents: 5000,
                    hustlerId: userId, // Internal User ID
                    hustlerStripeAccountId: hustlerId, // Stripe Account ID (e.g. acct_...)
                    destinationAccountId: hustlerId
                }, { stripeClient: fake });

                // 3. Assertions
                expect(FakeStripe.state.balances.get(hustlerId)).toBe(5000);
                expect(FakeStripe.state.transfers.size).toBe(1);

                // 4. Double Payout Protection (State Machine Guard)
                // Since handle() generates a NEW event ID, this is effectively a second attempt.
                // It SHOULD be blocked by the state machine (current_state='released').
                await expect(StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', {
                    payoutAmountCents: 5000,
                    hustlerId: userId,
                    hustlerStripeAccountId: hustlerId,
                    destinationAccountId: hustlerId
                }, { stripeClient: fake })).rejects.toThrow(/Invalid event RELEASE_PAYOUT/);

                expect(FakeStripe.state.transfers.size).toBe(1); // Still 1
                expect(FakeStripe.state.balances.get(hustlerId)).toBe(5000); // No double pay
            } catch (e) {
                throw e;
            }
        });
    });

    describe('Escrow Timeout Automation', () => {
        it('should auto-refund stuck escrow after timeout', async () => {
            const taskId = getTestId();
            const userId = getTestId();
            const fake = new FakeStripe();

            await transaction(async (tx) => {
                await tx`
                     INSERT INTO users (id, email, username, firebase_uid)
                     VALUES (${userId}, ${'test-' + userId + '@example.com'}, ${'User ' + userId}, ${'fb_' + userId})
                 `;

                // Task status is 'in_progress' (not completed), so should REFUND
                await tx`
                     INSERT INTO tasks (id, client_id, created_by, title, description, category, price, status, city, address, latitude, longitude, deadline, xp_reward)
                     VALUES (${taskId}, ${userId}, ${userId}, 'Stuck Task', 'Desc', 'moving', 50.00, 'in_progress', 'Seattle', '123 Test St', 47.6, -122.3, NOW() + INTERVAL '1 day', 100)
                  `;

                // Backdate lock to > 48h ago
                await tx`
                     INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, last_transition_at, stripe_payment_intent_id, stripe_charge_id, poster_uid)
                     VALUES (${taskId}, 'held', ${['RELEASE_PAYOUT', 'REFUND_ESCROW']}, NOW() - INTERVAL '50 hours', 'pi_stuck', 'ch_stuck', ${userId})
                  `;

                // Seed Ledger Accounts (Required by StripeMoneyEngine)
                await tx`
                    INSERT INTO ledger_accounts (id, owner_id, owner_type, type, balance, currency, name)
                    VALUES 
                    (${getTestId()}, ${userId}, 'user', 'receivable', 0, 'usd', 'Poster Receivable'),
                    (${getTestId()}, ${taskId}, 'task', 'task_escrow', 5000, 'usd', 'Task Escrow')
                 `;
            });

            // Run sweeper
            const results = await import('../src/cron/EscrowTimeoutSweeper.js').then(m => m.EscrowTimeoutSweeper.run({ stripeClient: fake }));

            const result = results.find(r => r.escrowId === taskId);
            // Logic: task not completed -> refund
            expect(result).toBeDefined();
            expect(result?.action).toBe('refunded'); // Or 'skipped' if refund impl details fail, but we expect action.
        }, 15000);
    });
});
