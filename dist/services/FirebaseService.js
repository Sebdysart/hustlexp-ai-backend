/**
 * Firebase Token Verification Service (JWKS-only)
 *
 * SECURITY: This service uses Google's public JWKS endpoint ONLY for token verification.
 * The Firebase Admin SDK private key is NOT used at runtime.
 *
 * Admin claim assignment can ONLY be done via offline scripts with local private key.
 * If you see private key in production environment, that's a security misconfiguration.
 */
import { logger } from '../utils/logger.js';
import * as jose from 'jose';
// Only need project ID for token verification
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
// SECURITY GUARD: Kill server IMMEDIATELY if private key is detected in PRODUCTION
// This prevents any regression - admin keys must NEVER be in production
if (process.env.FIREBASE_PRIVATE_KEY && process.env.NODE_ENV !== 'development') {
    console.error('\n');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('  FATAL SECURITY VIOLATION: FIREBASE_PRIVATE_KEY DETECTED');
    console.error('  Admin private key must NOT be present in production runtime.');
    console.error('  Remove FIREBASE_PRIVATE_KEY from environment and redeploy.');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('\n');
    process.exit(1);
}
else if (process.env.FIREBASE_PRIVATE_KEY) {
    logger.warn('FIREBASE_PRIVATE_KEY present - allowed in DEVELOPMENT mode only.');
}
if (process.env.FIREBASE_CLIENT_EMAIL) {
    logger.warn('FIREBASE_CLIENT_EMAIL detected - consider removing from production.');
}
// NO Admin SDK initialization - JWKS only
if (FIREBASE_PROJECT_ID) {
    logger.info({ projectId: FIREBASE_PROJECT_ID }, 'Firebase configured for JWKS-only token verification (secure mode)');
}
else {
    logger.warn('FIREBASE_PROJECT_ID not configured - authentication disabled');
}
// Cache JWKS for performance
let cachedJWKS = null;
async function getJWKS() {
    if (!cachedJWKS) {
        cachedJWKS = jose.createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
    }
    return cachedJWKS;
}
// ============================================
// Firebase Service (JWKS-only, no Admin SDK)
// ============================================
class FirebaseServiceClass {
    /**
     * Check if Firebase is available for token verification
     */
    isAvailable() {
        return !!FIREBASE_PROJECT_ID;
    }
    /**
     * Verify a Firebase ID token using JWKS (no private key required)
     */
    async verifyIdToken(idToken) {
        if (!FIREBASE_PROJECT_ID) {
            logger.warn('No Firebase project ID - cannot verify token');
            return null;
        }
        try {
            const JWKS = await getJWKS();
            const { payload } = await jose.jwtVerify(idToken, JWKS, {
                issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
                audience: FIREBASE_PROJECT_ID,
            });
            // Map to our DecodedToken interface
            // CRITICAL: Extract custom claims (admin, role) from the signed JWT
            const decoded = {
                uid: payload.sub,
                email: payload.email,
                email_verified: payload.email_verified,
                name: payload.name,
                auth_time: payload.auth_time,
                iat: payload.iat,
                exp: payload.exp,
                firebase: payload.firebase,
                // SECURITY: These are signed by Google - trustworthy source of admin privilege
                admin: payload.admin === true, // Explicit boolean check for safety
                role: payload.role,
            };
            logger.debug({ uid: decoded.uid }, 'Token verified via JWKS');
            return decoded;
        }
        catch (error) {
            logger.warn({ error }, 'JWKS token verification failed');
            return null;
        }
    }
    /**
     * DISABLED: Get user by UID - requires Admin SDK (not available in runtime)
     */
    async getUser(_uid) {
        logger.warn('getUser() is disabled in runtime - use offline admin scripts');
        return null;
    }
    /**
     * DISABLED: Get user by email - requires Admin SDK (not available in runtime)
     */
    async getUserByEmail(_email) {
        logger.warn('getUserByEmail() is disabled in runtime - use offline admin scripts');
        return null;
    }
    /**
     * DISABLED: Set custom claims - NEVER available at runtime
     * Use offline admin scripts: npx tsx scripts/admin-manage.ts grant <uid>
     */
    async setCustomClaims(_uid, _claims) {
        logger.error('SECURITY: setCustomClaims() is disabled in production runtime. Use offline admin scripts.');
        throw new Error('Admin elevation disabled in runtime');
    }
    /**
     * DISABLED: Create custom token - NEVER available at runtime
     * Use offline admin scripts for token generation
     */
    async createCustomToken(_uid, _claims) {
        logger.error('SECURITY: createCustomToken() is disabled in production runtime. Use offline admin scripts.');
        throw new Error('Token creation disabled in runtime');
    }
}
export const FirebaseService = new FirebaseServiceClass();
//# sourceMappingURL=FirebaseService.js.map