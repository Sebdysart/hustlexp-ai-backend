/**
 * Generate admin test token with proper JWT custom claims
 * 
 * SECURITY: This script sets the 'admin: true' custom claim on a Firebase user,
 * which is then embedded in their JWT by Google. The requireAdminFromJWT middleware
 * validates this signed claim - it cannot be forged.
 * 
 * Usage: npx tsx scripts/generate-admin-token.ts
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

const ADMIN_UID = 'test-admin-001';

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

async function generateAdminToken() {
    console.log('=== GENERATING ADMIN TOKEN WITH PROPER JWT CLAIMS ===\n');

    try {
        // Step 1: Set custom claims on the user (this persists in Firebase)
        // CRITICAL: 'admin: true' will be embedded in ALL future JWT tokens for this user
        console.log(`1. Setting custom claims on user ${ADMIN_UID}...`);
        await admin.auth().setCustomUserClaims(ADMIN_UID, {
            admin: true,  // This is the only way to grant admin - via private key
            testAccount: true
        });
        console.log('   ✅ Custom claims set: { admin: true, testAccount: true }');

        // Step 2: Create a custom token (this triggers token generation with the new claims)
        console.log('\n2. Creating custom token...');
        const customToken = await admin.auth().createCustomToken(ADMIN_UID, {
            admin: true,
            testAccount: true,
        });
        console.log('   ✅ Custom token created');

        // Step 3: Exchange for ID token (this is what gets sent to the API)
        console.log('\n3. Exchanging for ID token...');
        const idToken = await exchangeForIdToken(customToken);

        if (!idToken) {
            console.error('   ❌ Failed to exchange token');
            process.exit(1);
        }
        console.log('   ✅ ID token obtained');

        // Step 4: Verify the token has admin claim
        console.log('\n4. Verifying token has admin claim...');
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('   Token claims:', {
            uid: decoded.uid,
            admin: decoded.admin,
            testAccount: (decoded as Record<string, unknown>).testAccount,
        });

        if (decoded.admin === true) {
            console.log('   ✅ ADMIN CLAIM VERIFIED IN JWT');
        } else {
            console.log('   ⚠️  Admin claim not found - token may need refresh');
        }

        // Output export command
        console.log('\n=== EXPORT COMMAND ===\n');
        console.log(`export ADMIN_TOKEN="${idToken}"`);
        console.log(`export ADMIN_UID="${ADMIN_UID}"`);
        console.log('');

        // Test curl command
        console.log('=== TEST COMMAND ===\n');
        console.log('curl -s https://hustlexp-ai-backend-production.up.railway.app/api/admin/disputes \\');
        console.log(`  -H "Authorization: Bearer $ADMIN_TOKEN" | jq`);
        console.log('');

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }

    await app.delete();
}

generateAdminToken();
