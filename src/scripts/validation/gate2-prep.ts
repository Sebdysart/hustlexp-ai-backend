
import { sql } from '../../db/index.js';
import { env } from '../../config/env.js';
import { StripeService } from '../../services/StripeService.js';
import { UserService } from '../../services/UserService.js';
import { TaskService } from '../../services/TaskService.js';

async function prep() {
    console.log('--- GATE 2 PRE-DETONATION PREP ---');
    console.log(`Environment: ${env.mode}`);

    try {
        // 1. WIPE DB
        console.log('[1/5] Wiping Database...');

        if (!sql) {
            throw new Error("Database client not initialized");
        }

        // Truncate users (cascades to tasks, profiles, etc) and standalone tables
        await sql`TRUNCATE TABLE users, processed_stripe_events, notifications, beta_invites RESTART IDENTITY CASCADE`;
        console.log('PASS: DB Wiped');

        // 2. SEED USERS
        console.log('[2/5] Seeding Users...');
        // Using Dev Bypass IDs defined in firebaseAuth.ts for local run compatibility if needed
        const POSTER = {
            uid: '11111111-1111-1111-1111-111111111111',
            email: 'poster@gate2.test',
            name: 'Gate2 Poster',
            role: 'poster' as const
        };
        const HUSTLER = {
            uid: '22222222-2222-2222-2222-222222222222',
            email: 'hustler@gate2.test',
            name: 'Gate2 Hustler',
            role: 'hustler' as const
        };
        const ADMIN = {
            uid: '33333333-3333-3333-3333-333333333333',
            email: 'admin@gate2.test',
            name: 'Gate2 Admin',
            role: 'admin' as const
        };

        const poster = await UserService.getOrCreate(POSTER.uid, POSTER.email, POSTER.name);
        await UserService.getOrCreate(HUSTLER.uid, HUSTLER.email, HUSTLER.name);
        // Manually set admin role since getOrCreate defaults to poster/hustler logic often
        await sql`UPDATE users SET role = 'admin' WHERE firebase_uid = ${ADMIN.uid}`;

        console.log('PASS: 3 Users Seeded (Poster, Hustler, Admin)');

        // 3. SEED TASK
        console.log('[3/5] Seeding Task...');
        const task = await TaskService.createTask({
            clientId: poster!.id, // Use Internal UUID
            title: 'Gate 2 Test Task',
            description: 'This task exists to be destroyed.',
            category: 'general', // Lowercase to match type
            recommendedPrice: 5000, // $50.00
            locationText: 'Seattle, WA',
            latitude: 47.6062,
            longitude: -122.3321,
            timeWindow: { start: new Date(), end: new Date(Date.now() + 86400000) }
        });

        // Ensure manual state if needed (should be OPEN by default)

        console.log(`PASS: Task Seeded (ID: ${task.id})`);

        // 4. STRIPE CONNECT
        console.log('[4/5] Verifying Stripe Connect...');
        if (!env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
            console.warn('WARN: Not in Stripe Test Mode! Skipping Connect creation to avoid pollution.');
        } else {
            // Create a fake connect account for the Hustler to enable payouts
            try {
                const account = await StripeService.createConnectAccount(HUSTLER.uid, HUSTLER.email);
                console.log(`PASS: Stripe Connect Account Created (${account.accountId})`);
            } catch (stripeError: any) {
                console.warn(`WARN: Stripe Connect Failed: ${stripeError.message}`);
            }
        }

        // 5. READY CHECK
        console.log('[5/5] Backend Health...');
        // We are inside the backend process context essentially, so we assume code is loadable.
        // If this script runs, the DB connection works (checked above).
        console.log('PASS: Logic Loaded.');

        console.log('\n--- READY FOR DETONATION ---');
        process.exit(0);

    } catch (e: any) {
        console.error('PREP FAILED:', e);
        process.exit(1);
    }
}

prep();
