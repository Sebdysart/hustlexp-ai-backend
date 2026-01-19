/**
 * Firebase Token Verification Service (JWKS-only)
 *
 * SECURITY: This service uses Google's public JWKS endpoint ONLY for token verification.
 * The Firebase Admin SDK private key is NOT used at runtime.
 *
 * Admin claim assignment can ONLY be done via offline scripts with local private key.
 * If you see private key in production environment, that's a security misconfiguration.
 */
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
    admin?: boolean;
    role?: string;
}
declare class FirebaseServiceClass {
    /**
     * Check if Firebase is available for token verification
     */
    isAvailable(): boolean;
    /**
     * Verify a Firebase ID token using JWKS (no private key required)
     */
    verifyIdToken(idToken: string): Promise<DecodedToken | null>;
    /**
     * DISABLED: Get user by UID - requires Admin SDK (not available in runtime)
     */
    getUser(_uid: string): Promise<FirebaseUser | null>;
    /**
     * DISABLED: Get user by email - requires Admin SDK (not available in runtime)
     */
    getUserByEmail(_email: string): Promise<FirebaseUser | null>;
    /**
     * DISABLED: Set custom claims - NEVER available at runtime
     * Use offline admin scripts: npx tsx scripts/admin-manage.ts grant <uid>
     */
    setCustomClaims(_uid: string, _claims: Record<string, unknown>): Promise<boolean>;
    /**
     * DISABLED: Create custom token - NEVER available at runtime
     * Use offline admin scripts for token generation
     */
    createCustomToken(_uid: string, _claims?: Record<string, unknown>): Promise<string | null>;
}
export declare const FirebaseService: FirebaseServiceClass;
export {};
//# sourceMappingURL=FirebaseService.d.ts.map