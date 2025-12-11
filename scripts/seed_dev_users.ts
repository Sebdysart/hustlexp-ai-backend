
import { sql } from '../src/db/index.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-11-17.clover' as any,
    typescript: true,
});

async function main() {
    console.log('Seeding dev users...');
    if (!sql) {
        console.error('No SQL connection');
        process.exit(1);
    }

    try {
        await sql`
            INSERT INTO users (id, email, name, role, created_at, updated_at) 
            VALUES ('11111111-1111-1111-1111-111111111111', 'dev@local.test', 'Dev User', 'poster', NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET role = 'poster'
        `;
        console.log('Seeded dev-user (Poster)');

        // Create Stripe Connect Account for Hustler
        console.log('Creating Stripe Connect Account...');
        const account = await stripe.accounts.create({
            type: 'custom',
            country: 'US',
            email: 'hustler@local.test',
            capabilities: {
                transfers: { requested: true },
                card_payments: { requested: true },
            },
            tos_acceptance: {
                date: Math.floor(Date.now() / 1000),
                ip: '127.0.0.1',
            },
            business_profile: {
                url: 'https://hustlexp.com',
                mcc: '5734',
            },
        });
        console.log(`Created Stripe Account: ${account.id}`);

        await sql`
            INSERT INTO users (id, email, name, role, created_at, updated_at, stripe_account_id) 
            VALUES ('22222222-2222-2222-2222-222222222222', 'hustler@local.test', 'Test Hustler', 'hustler', NOW(), NOW(), ${account.id})
            ON CONFLICT (id) DO UPDATE SET role = 'hustler', stripe_account_id = ${account.id}
        `;
        console.log('Seeded test-hustler-001 with Stripe Account');

    } catch (err) {
        console.error('Seed failed:', err);
        process.exit(1);
    }

    console.log('Done.');
    process.exit(0);
}

main();
