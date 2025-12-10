/**
 * Firebase Admin SDK Service
 * 
 * Initializes Firebase Admin and provides user verification.
 * Token verification works with OR without service account credentials
 * by using Google's public JWKS endpoint as fallback.
 */

import admin from 'firebase-admin';
import { logger } from '../utils/logger.js';
import * as jose from 'jose';

// Check if Firebase is configured with full credentials
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const isFirebaseFullyConfigured = !!(
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
);

// Initialize Firebase Admin (full mode if credentials available)
let firebaseApp: admin.app.App | null = null;

if (isFirebaseFullyConfigured) {
    try {
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: FIREBASE_PROJECT_ID,
                clientEmail: FIREBASE_CLIENT_EMAIL,
                privateKey: FIREBASE_PRIVATE_KEY,
            }),
        });
        logger.info({ projectId: FIREBASE_PROJECT_ID }, 'Firebase Admin SDK initialized (full mode)');
    } catch (error) {
        logger.error({ error }, 'Failed to initialize Firebase Admin SDK');
    }
} else if (FIREBASE_PROJECT_ID) {
    // Partial config - can still verify tokens via JWKS
    logger.info({ projectId: FIREBASE_PROJECT_ID }, 'Firebase configured for JWKS token verification only');
} else {
    logger.warn('Firebase credentials not configured - authentication disabled');
}

// ============================================
// Types
// ============================================

export interface FirebaseUser {
    uid: string;
    email?: string;
    emailVerified: boolean;
    displayName?: string;
    photoURL?: string;
    phoneNumber?: string;
    disabled: boolean;
    customClaims?: Record<string, unknown>;
}

export interface DecodedToken {
    uid: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    phone_number?: string;
    auth_time: number;
    iat: number;
    exp: number;
    firebase: {
        identities: Record<string, unknown>;
        sign_in_provider: string;
    };
    // Custom claims (set via Firebase Admin SDK)
    admin?: boolean;  // CRITICAL: Only admin if this is TRUE in signed JWT
    role?: string;    // Token-embedded role claim (optional, for reference)
}

// Cache JWKS for performance
let cachedJWKS: jose.JWTVerifyGetKey | null = null;

async function getJWKS(): Promise<jose.JWTVerifyGetKey> {
    if (!cachedJWKS) {
        cachedJWKS = jose.createRemoteJWKSet(
            new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
        );
    }
    return cachedJWKS;
}

// ============================================
// Firebase Service
// ============================================

class FirebaseServiceClass {
    /**
     * Check if Firebase is available for token verification
     */
    isAvailable(): boolean {
        return firebaseApp !== null || !!FIREBASE_PROJECT_ID;
    }

    /**
     * Verify a Firebase ID token
     * Uses Admin SDK if available, otherwise uses JWKS verification
     */
    async verifyIdToken(idToken: string): Promise<DecodedToken | null> {
        // Try Admin SDK first if available
        if (firebaseApp) {
            try {
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                return decodedToken as DecodedToken;
            } catch (error) {
                logger.warn({ error }, 'Admin SDK token verification failed');
                return null;
            }
        }

        // Fallback to JWKS verification (no private key needed)
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
            const decoded: DecodedToken = {
                uid: payload.sub!,
                email: payload.email as string | undefined,
                email_verified: payload.email_verified as boolean | undefined,
                name: payload.name as string | undefined,
                auth_time: payload.auth_time as number,
                iat: payload.iat!,
                exp: payload.exp!,
                firebase: payload.firebase as DecodedToken['firebase'],
                // SECURITY: These are signed by Google - trustworthy source of admin privilege
                admin: payload.admin === true,  // Explicit boolean check for safety
                role: payload.role as string | undefined,
            };

            logger.debug({ uid: decoded.uid }, 'Token verified via JWKS');
            return decoded;
        } catch (error) {
            logger.warn({ error }, 'JWKS token verification failed');
            return null;
        }
    }

    /**
     * Get user by UID
     */
    async getUser(uid: string): Promise<FirebaseUser | null> {
        if (!firebaseApp) return null;

        try {
            const user = await admin.auth().getUser(uid);
            return {
                uid: user.uid,
                email: user.email,
                emailVerified: user.emailVerified,
                displayName: user.displayName,
                photoURL: user.photoURL,
                phoneNumber: user.phoneNumber,
                disabled: user.disabled,
                customClaims: user.customClaims,
            };
        } catch (error) {
            logger.warn({ error, uid }, 'User not found');
            return null;
        }
    }

    /**
     * Get user by email
     */
    async getUserByEmail(email: string): Promise<FirebaseUser | null> {
        if (!firebaseApp) return null;

        try {
            const user = await admin.auth().getUserByEmail(email);
            return {
                uid: user.uid,
                email: user.email,
                emailVerified: user.emailVerified,
                displayName: user.displayName,
                photoURL: user.photoURL,
                phoneNumber: user.phoneNumber,
                disabled: user.disabled,
                customClaims: user.customClaims,
            };
        } catch (error) {
            logger.warn({ error, email }, 'User not found by email');
            return null;
        }
    }

    /**
     * Set custom claims on a user (for roles, permissions, etc.)
     */
    async setCustomClaims(uid: string, claims: Record<string, unknown>): Promise<boolean> {
        if (!firebaseApp) return false;

        try {
            await admin.auth().setCustomUserClaims(uid, claims);
            logger.info({ uid, claims }, 'Custom claims set');
            return true;
        } catch (error) {
            logger.error({ error, uid }, 'Failed to set custom claims');
            return false;
        }
    }

    /**
     * Create a custom token for a user (for testing or special auth flows)
     */
    async createCustomToken(uid: string, claims?: Record<string, unknown>): Promise<string | null> {
        if (!firebaseApp) return null;

        try {
            return await admin.auth().createCustomToken(uid, claims);
        } catch (error) {
            logger.error({ error, uid }, 'Failed to create custom token');
            return null;
        }
    }
}

export const FirebaseService = new FirebaseServiceClass();
