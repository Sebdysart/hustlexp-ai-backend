/**
 * Generate a test ID token for Gate-1 verification
 * 
 * This uses the Firebase Admin SDK (already configured in .env) to create
 * a custom token, then exchanges it for an ID token via Firebase REST API.
 * 
 * Usage: npx tsx scripts/get-test-token.ts
 */

import admin from 'firebase-admin';
import 'dotenv/config';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.error('Missing Firebase Admin credentials in .env');
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

async function getTestToken() {
    // Test user UID - we'll create a synthetic one for testing
    const testHustlerUid = 'test-hustler-001';

    try {
        // Create custom token with Admin SDK
        const customToken = await admin.auth().createCustomToken(testHustlerUid, {
            role: 'hustler',
            testAccount: true,
        });

        console.log('Custom token created for UID:', testHustlerUid);
        console.log('');

        // Exchange custom token for ID token via Firebase REST API
        // This requires the Web API Key - check if it's set
        const webApiKey = process.env.FIREBASE_WEB_API_KEY;

        if (webApiKey) {
            const response = await fetch(
                `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`,
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

            if (data.idToken) {
                console.log('=== HUSTLER_TOKEN (ID Token) ===');
                console.log('');
                console.log('HUSTLER_TOKEN=' + data.idToken);
                console.log('');
                console.log('HUSTLER_UID=' + testHustlerUid);
            } else {
                console.log('Failed to exchange custom token:', data.error?.message || data);
                console.log('');
                console.log('=== CUSTOM TOKEN (use if Web API Key not available) ===');
                console.log('CUSTOM_TOKEN=' + customToken);
            }
        } else {
            console.log('FIREBASE_WEB_API_KEY not set in .env');
            console.log('Cannot exchange custom token for ID token.');
            console.log('');
            console.log('=== CUSTOM TOKEN ===');
            console.log('CUSTOM_TOKEN=' + customToken);
            console.log('');
            console.log('To get ID token, add FIREBASE_WEB_API_KEY to .env');
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await app.delete();
    }
}

getTestToken();
