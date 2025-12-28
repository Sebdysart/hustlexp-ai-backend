/**
 * Generate a Firebase custom token for stress testing
 * 
 * Usage:
 *   npx ts-node scripts/genTestToken.ts
 * 
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to service account JSON
 *   - OR FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL + FIREBASE_PROJECT_ID set
 */

import admin from 'firebase-admin';
import { sql, isDatabaseAvailable } from '../src/db/index.js';

// Initialize Firebase Admin
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
        }),
    });
} else {
    // Fallback to application default credentials
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
    });
}

const TEST_USER_ID = 'tpee-stress-test-user-' + Date.now();
const TEST_EMAIL = `stress-test-${Date.now()}@hustlexp.test`;

async function ensureTestUserInDB() {
    if (!isDatabaseAvailable() || !sql) {
        console.log('⚠️  Database not available - skipping DB user creation');
        console.log('   You may need to manually create the test user in the database');
        return;
    }

    try {
        // Create test user in database
        await sql`
            INSERT INTO users (id, email, role, email_verified, trust_score, level, created_at)
            VALUES (
                ${TEST_USER_ID}::uuid,
                ${TEST_EMAIL},
                'poster',
                true,
                75,
                1,
                NOW()
            )
            ON CONFLICT (id) DO NOTHING
        `;

        // Create identity verification record (email verified, phone not required for test)
        await sql`
            INSERT INTO identity_verification (user_id, email, email_verified, email_verified_at)
            VALUES (
                ${TEST_USER_ID}::uuid,
                ${TEST_EMAIL},
                true,
                NOW()
            )
            ON CONFLICT (user_id) DO NOTHING
        `;

        console.log('✅ Test user created in database');
        console.log(`   User ID: ${TEST_USER_ID}`);
        console.log(`   Email: ${TEST_EMAIL}`);
        console.log(`   Role: poster`);
        console.log(`   Trust Score: 75`);
    } catch (error) {
        console.error('❌ Failed to create test user in DB:', error);
    }
}

async function generateToken() {
    console.log('\n🔐 Generating Firebase Custom Token for Stress Testing\n');
    console.log('━'.repeat(60));

    try {
        // Create custom token with claims
        const customToken = await admin.auth().createCustomToken(TEST_USER_ID, {
            role: 'poster',
            email_verified: true,
        });

        console.log('\n✅ Custom Token Generated Successfully!\n');
        console.log('━'.repeat(60));
        console.log('\n📋 EXPORT THIS TOKEN:\n');
        console.log(`export AUTH_TOKEN="${customToken}"`);
        console.log('\n━'.repeat(60));
        console.log('\n⚠️  IMPORTANT: This is a CUSTOM token, not an ID token.');
        console.log('   Your backend must accept custom tokens OR you need to');
        console.log('   exchange this for an ID token using Firebase REST API.\n');

        // Also create the user in DB if possible
        await ensureTestUserInDB();

        console.log('\n━'.repeat(60));
        console.log('📝 Test User Details:');
        console.log(`   UID: ${TEST_USER_ID}`);
        console.log(`   Email: ${TEST_EMAIL}`);
        console.log(`   Role: poster (NOT admin)`);
        console.log('━'.repeat(60));

    } catch (error) {
        console.error('❌ Failed to generate token:', error);
        process.exit(1);
    }

    process.exit(0);
}

generateToken();
