/**
 * Firebase Authentication Middleware
 * 
 * Verifies Firebase ID tokens via JWKS and attaches user info to requests.
 * Roles are fetched from the database (UserService), NOT Firebase custom claims.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { FirebaseService, type DecodedToken } from '../services/FirebaseService.js';
import { UserService, type UserRole, type DbUser } from '../services/UserService.js';
import { logger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

// Extend FastifyRequest to include user info WITH ROLE
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
    role?: UserRole; // Role from database
}

// ============================================
// Helper Functions
// ============================================

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        return null;
    }

    return parts[1];
}

/**
 * Convert decoded token to AuthenticatedUser
 */
function tokenToUser(token: DecodedToken): AuthenticatedUser {
    return {
        uid: token.uid,
        email: token.email,
        emailVerified: token.email_verified ?? false,
        name: token.name,
        signInProvider: token.firebase?.sign_in_provider || 'unknown',
        authTime: new Date(token.auth_time * 1000),
        tokenExpiry: new Date(token.exp * 1000),
    };
}

// ============================================
// Middleware Functions
// ============================================

/**
 * Require authentication - blocks request if not authenticated
 * Also fetches user from database and attaches role
 */
export async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    // Check if Firebase is configured
    if (!FirebaseService.isAvailable()) {
        // In development without Firebase, allow requests through with mock user
        if (process.env.NODE_ENV === 'development') {
            logger.warn('Firebase not configured - using development bypass');
            request.user = {
                uid: 'dev-user',
                email: 'dev@local.test',
                emailVerified: true,
                name: 'Development User',
                signInProvider: 'development',
                authTime: new Date(),
                tokenExpiry: new Date(Date.now() + 3600000),
                role: 'poster',
            };
            return;
        }

        reply.status(503).send({
            error: 'Authentication service unavailable',
            code: 'AUTH_SERVICE_UNAVAILABLE',
        });
        return;
    }

    // Extract token
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
        reply.status(401).send({
            error: 'Authorization header required',
            code: 'MISSING_TOKEN',
        });
        return;
    }

    // Verify token via JWKS
    const decodedToken = await FirebaseService.verifyIdToken(token);

    if (!decodedToken) {
        reply.status(401).send({
            error: 'Invalid or expired token',
            code: 'INVALID_TOKEN',
        });
        return;
    }

    // Convert to user object
    const user = tokenToUser(decodedToken);

    // Fetch or create user in database to get role
    const dbUser = await UserService.getOrCreate(
        decodedToken.uid,
        decodedToken.email || `${decodedToken.uid}@hustlexp.com`,
        decodedToken.name
    );

    if (dbUser) {
        user.role = dbUser.role;
        request.dbUser = dbUser;
    } else {
        // Default to poster if can't get from DB
        user.role = 'poster';
    }

    // Attach user to request
    request.user = user;

    logger.debug({ uid: user.uid, role: user.role }, 'Request authenticated with role');
}

/**
 * Optional authentication - attaches user if token present, but doesn't block
 */
export async function optionalAuth(
    request: FastifyRequest,
    _reply: FastifyReply
): Promise<void> {
    if (!FirebaseService.isAvailable()) {
        return;
    }

    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
        return; // No token, continue without user
    }

    const decodedToken = await FirebaseService.verifyIdToken(token);

    if (decodedToken) {
        const user = tokenToUser(decodedToken);

        // Fetch role from database
        const dbUser = await UserService.getByFirebaseUid(decodedToken.uid);
        if (dbUser) {
            user.role = dbUser.role;
            request.dbUser = dbUser;
        }

        request.user = user;
        logger.debug({ uid: user.uid, role: user.role }, 'Optional auth - user attached');
    }
}

/**
 * Require specific role - uses database role, NOT Firebase custom claims
 */
export function requireRole(role: UserRole) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        // First ensure authenticated
        await requireAuth(request, reply);

        if (reply.sent) return; // Auth already failed

        const user = request.user;
        if (!user) {
            reply.status(403).send({
                error: 'Access denied',
                code: 'NO_USER',
            });
            return;
        }

        // Check role from database (already attached by requireAuth)
        const userRole = user.role;

        // Admin can do anything
        if (userRole === 'admin') {
            return;
        }

        if (userRole !== role) {
            logger.warn({
                uid: user.uid,
                userRole,
                requiredRole: role
            }, 'Role check failed');

            reply.status(403).send({
                error: 'FORBIDDEN',
                code: 'INSUFFICIENT_ROLE',
                userRole: userRole,
                requiredRole: role,
            });
            return;
        }
    };
}

/**
 * Check if Firebase authentication is enabled
 */
export function isAuthEnabled(): boolean {
    return FirebaseService.isAvailable();
}

