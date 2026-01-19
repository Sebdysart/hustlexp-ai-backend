/**
 * Firebase Authentication Middleware
 *
 * Verifies Firebase ID tokens via JWKS and attaches user info to requests.
 * Roles are fetched from the database (UserService), NOT Firebase custom claims.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { type UserRole, type DbUser } from '../services/UserService.js';
declare module 'fastify' {
    interface FastifyRequest {
        user?: AuthenticatedUser;
        dbUser?: DbUser;
    }
}
export interface AuthenticatedUser {
    uid: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
    picture?: string;
    phoneNumber?: string;
    signInProvider: string;
    authTime: Date;
    tokenExpiry: Date;
    role?: UserRole;
}
/**
 * Require authentication - blocks request if not authenticated
 * Also fetches user from database and attaches role
 */
export declare function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/**
 * Optional authentication - attaches user if token present, but doesn't block
 */
export declare function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void>;
/**
 * Require specific role - uses database role for poster/hustler
 * SECURITY: Admin bypass REMOVED - admin is now ONLY via JWT claim
 */
export declare function requireRole(role: UserRole): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
/**
 * CRITICAL SECURITY: Require admin privilege from JWT custom claims ONLY
 *
 * Admin privilege is determined by:
 * 1. The JWT must be valid (signed by Google/Firebase)
 * 2. The JWT payload must contain: admin: true
 * 3. DB role is IRRELEVANT for admin - cannot grant nor revoke admin
 *
 * To set admin on a user, use Firebase Admin SDK:
 *   admin.auth().setCustomUserClaims(uid, { admin: true })
 *
 * This can ONLY be done with the private key, never via API.
 */
export declare function requireAdminFromJWT(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/**
 * Check if Firebase authentication is enabled
 */
export declare function isAuthEnabled(): boolean;
//# sourceMappingURL=firebaseAuth.d.ts.map