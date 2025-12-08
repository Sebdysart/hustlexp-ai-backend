/**
 * Firebase Authentication Middleware
 * 
 * Verifies Firebase ID tokens and attaches user info to requests.
 * Can be used as a Fastify preHandler.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { FirebaseService, type DecodedToken } from '../services/FirebaseService.js';
import { logger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

// Extend FastifyRequest to include user info
declare module 'fastify' {
    interface FastifyRequest {
        user?: AuthenticatedUser;
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
        picture: token.picture,
        phoneNumber: token.phone_number,
        signInProvider: token.firebase.sign_in_provider,
        authTime: new Date(token.auth_time * 1000),
        tokenExpiry: new Date(token.exp * 1000),
    };
}

// ============================================
// Middleware Functions
// ============================================

/**
 * Require authentication - blocks request if not authenticated
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

    // Verify token
    const decodedToken = await FirebaseService.verifyIdToken(token);

    if (!decodedToken) {
        reply.status(401).send({
            error: 'Invalid or expired token',
            code: 'INVALID_TOKEN',
        });
        return;
    }

    // Attach user to request
    request.user = tokenToUser(decodedToken);

    logger.debug({ uid: request.user.uid }, 'Request authenticated');
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
        request.user = tokenToUser(decodedToken);
        logger.debug({ uid: request.user.uid }, 'Optional auth - user attached');
    }
}

/**
 * Require specific role (from custom claims)
 */
export function requireRole(role: string) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        // First ensure authenticated
        await requireAuth(request, reply);

        if (reply.sent) return; // Auth already failed

        // Check role in custom claims
        const user = request.user;
        if (!user) {
            reply.status(403).send({
                error: 'Access denied',
                code: 'NO_USER',
            });
            return;
        }

        // Get full user info to check claims
        const fullUser = await FirebaseService.getUser(user.uid);
        const userRole = fullUser?.customClaims?.role as string | undefined;

        if (userRole !== role && userRole !== 'admin') {
            reply.status(403).send({
                error: `Role '${role}' required`,
                code: 'INSUFFICIENT_ROLE',
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
