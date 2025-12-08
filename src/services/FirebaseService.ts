/**
 * Firebase Admin SDK Service
 * 
 * Initializes Firebase Admin and provides user verification.
 */

import admin from 'firebase-admin';
import { logger } from '../utils/logger.js';

// Check if Firebase is configured
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const isFirebaseConfigured = !!(
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
);

// Initialize Firebase Admin
let firebaseApp: admin.app.App | null = null;

if (isFirebaseConfigured) {
    try {
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: FIREBASE_PROJECT_ID,
                clientEmail: FIREBASE_CLIENT_EMAIL,
                privateKey: FIREBASE_PRIVATE_KEY,
            }),
        });
        logger.info({ projectId: FIREBASE_PROJECT_ID }, 'Firebase Admin SDK initialized');
    } catch (error) {
        logger.error({ error }, 'Failed to initialize Firebase Admin SDK');
    }
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
}

// ============================================
// Firebase Service
// ============================================

class FirebaseServiceClass {
    /**
     * Check if Firebase is available
     */
    isAvailable(): boolean {
        return firebaseApp !== null;
    }

    /**
     * Verify a Firebase ID token
     */
    async verifyIdToken(idToken: string): Promise<DecodedToken | null> {
        if (!firebaseApp) {
            logger.warn('Firebase not initialized - cannot verify token');
            return null;
        }

        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            return decodedToken as DecodedToken;
        } catch (error) {
            logger.warn({ error }, 'Invalid Firebase ID token');
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
