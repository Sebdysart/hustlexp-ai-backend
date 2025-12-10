/**
 * Test admin revocation - removes admin claim and verifies access is blocked
 * 
 * Tests:
 * 1. Remove admin claim from user
 * 2. Generate new token (should NOT have admin claim)
 * 3. Verify access is now blocked
 */

import admin from 'firebase-admin';
import 'dotenv/config';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const HOST = 'https://hustlexp-ai-backend-production.up.railway.app';

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.error('Missing Firebase Admin credentials');
    process.exit(1);
}

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
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        }
    );
    const data = await response.json() as { idToken?: string };
    return data.idToken || null;
}

async function testAdminEndpoint(token: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${HOST}/api/admin/disputes`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    return { status: res.status, body };
}

async function runRevocationTest() {
    console.log('=== ADMIN REVOCATION TEST ===\n');

    // Step 1: Verify current admin has access
    console.log('1. Testing with existing admin token...');
    const adminToken = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJhZG1pbiI6dHJ1ZSwidGVzdEFjY291bnQiOnRydWUsImlzcyI6Imh0dHBzOi8vc2VjdXJldG9rZW4uZ29vZ2xlLmNvbS9odXN0bGV4cC1mbHktbmV3IiwiYXVkIjoiaHVzdGxleHAtZmx5LW5ldyIsImF1dGhfdGltZSI6MTc2NTM2NDE5NCwidXNlcl9pZCI6InRlc3QtYWRtaW4tMDAxIiwic3ViIjoidGVzdC1hZG1pbi0wMDEiLCJpYXQiOjE3NjUzNjQxOTQsImV4cCI6MTc2NTM2Nzc5NCwiZmlyZWJhc2UiOnsiaWRlbnRpdGllcyI6e30sInNpZ25faW5fcHJvdmlkZXIiOiJjdXN0b20ifX0.dW_AIBAsLjIm54tw73Clv_XI0uFdJQzShp_HrNjFWP6YNdszib2DazDQFxLrxJNlk0y1N1NzuaGVrqSXNbQKMY1rjzvT5_qWzvRttonhC_Q_xlVeI-xxWQfxMf0LXOUgU6_L0vOsGgB1locW5bIDT_1cr_gZUq-CAj_2qcOWc_JOTYaMMrl1Ah2R29b9_jTMZKHwJTmmB1i06SOaqW4SMyiodn7I_JySlFNBYksUd7VwNpoMqPghvXwyj6oJsXrWZC0SKTTTfGt9wvoFbnRhPhcgCwQN6CCv7XtA7LtqIqC3AY9Z0Vr8tlNRIms1e4w9nrJlIP3K9ZzOeX5px5ULAw';
    const r1 = await testAdminEndpoint(adminToken);
    console.log(`   HTTP ${r1.status} - ${r1.status === 200 ? '✅ Has access' : '❌ Blocked'}`);

    // Step 2: Remove admin claim
    console.log('\n2. Removing admin claim (setting to false)...');
    await admin.auth().setCustomUserClaims(ADMIN_UID, {
        admin: false,  // Explicitly set to false
        testAccount: true
    });
    console.log('   ✅ Claim removed');

    // Step 3: Generate NEW token (claims are baked into the token at generation time)
    console.log('\n3. Generating new token (should NOT have admin claim)...');
    const customToken = await admin.auth().createCustomToken(ADMIN_UID, {
        admin: false,
        testAccount: true,
    });
    const newToken = await exchangeForIdToken(customToken);
    if (!newToken) {
        console.error('   ❌ Failed to get new token');
        process.exit(1);
    }

    // Verify the new token
    const decoded = await admin.auth().verifyIdToken(newToken);
    console.log(`   Token admin claim: ${decoded.admin}`);

    // Step 4: Test with revoked token
    console.log('\n4. Testing with post-revocation token...');
    const r2 = await testAdminEndpoint(newToken);
    console.log(`   HTTP ${r2.status} - ${r2.status === 403 ? '✅ Correctly blocked' : '❌ STILL HAS ACCESS (BAD)'}`);
    console.log(`   Response: ${r2.body}`);

    // Step 5: Restore admin for future tests
    console.log('\n5. Restoring admin claim...');
    await admin.auth().setCustomUserClaims(ADMIN_UID, {
        admin: true,
        testAccount: true
    });
    console.log('   ✅ Admin restored');

    // Summary
    console.log('\n=== REVOCATION TEST COMPLETE ===');
    if (r1.status === 200 && r2.status === 403) {
        console.log('✅ PASS: Revocation works - new token is blocked');
    } else if (r1.status === 200 && r2.status === 200) {
        console.log('❌ FAIL: OLD token still works (expected until it expires)');
        console.log('   But: NEW token should be blocked. Check if r2 actually got a fresh token.');
    } else {
        console.log('⚠️  Unexpected results - review manually');
    }

    await app.delete();
}

runRevocationTest();
