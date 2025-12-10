/**
 * Generate test ID tokens for ALL roles needed in Gate-1 verification
 * 
 * Creates tokens for: hustler, poster, admin, random (no-role)
 * 
 * Usage: npx tsx scripts/generate-all-test-tokens.ts
 */

import admin from 'firebase-admin';
import 'dotenv/config';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.error('Missing Firebase Admin credentials in .env');
    process.exit(1);
}

if (!WEB_API_KEY) {
    console.error('Missing FIREBASE_WEB_API_KEY in .env');
    process.exit(1);
}

// Initialize Firebase Admin
const app = admin.initializeApp({
    credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY,
    }),
});

interface TestUser {
    uid: string;
    role: string;
    envVar: string;
}

const TEST_USERS: TestUser[] = [
    { uid: 'test-hustler-001', role: 'hustler', envVar: 'HUSTLER' },
    { uid: 'test-poster-001', role: 'poster', envVar: 'POSTER' },
    { uid: 'test-admin-001', role: 'admin', envVar: 'ADMIN' },
    { uid: 'test-random-001', role: '', envVar: 'RANDOM' },  // No role
];

async function exchangeForIdToken(customToken: string): Promise<string | null> {
    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: customToken,
                returnSecureToken: true,
            }),
        }
    );

    const data = await response.json() as { idToken?: string; error?: { message: string } };
    return data.idToken || null;
}

async function generateAllTokens() {
    console.log('=== GENERATING TEST TOKENS FOR GATE-1 ===\n');

    const results: Record<string, { uid: string; token: string }> = {};

    for (const user of TEST_USERS) {
        try {
            const claims: Record<string, unknown> = { testAccount: true };
            if (user.role) {
                claims.role = user.role;
            }

            const customToken = await admin.auth().createCustomToken(user.uid, claims);
            const idToken = await exchangeForIdToken(customToken);

            if (idToken) {
                results[user.envVar] = { uid: user.uid, token: idToken };
                console.log(`✅ ${user.envVar}: ${user.role || '(no role)'}`);
            } else {
                console.log(`❌ ${user.envVar}: Failed to exchange token`);
            }
        } catch (error) {
            console.error(`❌ ${user.envVar}: Error -`, error);
        }
    }

    console.log('\n=== EXPORT COMMANDS ===\n');

    for (const [varName, data] of Object.entries(results)) {
        console.log(`export ${varName}_UID="${data.uid}"`);
        console.log(`export ${varName}_TOKEN="${data.token}"`);
        console.log('');
    }

    console.log('export HOST="https://hustlexp-ai-backend-production.up.railway.app"');
    console.log('');

    await app.delete();
}

generateAllTokens();
