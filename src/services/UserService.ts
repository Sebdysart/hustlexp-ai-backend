/**
 * User Service - Database-backed user management
 * 
 * Handles user CRUD and role management via Neon database.
 * Roles are stored here, NOT in Firebase custom claims.
 */

import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import type { User, HustlerProfile } from '../types/index.js';

// ============================================
// Types
// ============================================

export type UserRole = 'poster' | 'hustler' | 'admin';

export interface DbUser {
    id: string;
    firebase_uid: string | null;
    email: string;
    name: string;
    role: UserRole;
    created_at: Date;
    updated_at: Date;
}

// ============================================
// In-memory fallback for when DB is unavailable
// ============================================

const fallbackUsers = new Map<string, DbUser>();
const hustlerProfiles: Map<string, HustlerProfile> = new Map();

// Add test users for development fallback
fallbackUsers.set('nSOBs9jyIMerrZjH5hMKvGDSGc83', {
    id: 'test-poster-id',
    firebase_uid: 'nSOBs9jyIMerrZjH5hMKvGDSGc83',
    email: 'poster_test@hustlexp.com',
    name: 'Test Poster',
    role: 'poster',
    created_at: new Date(),
    updated_at: new Date(),
});

fallbackUsers.set('7GUnkBFStzUy8Q9wtyY51lB96Vo2', {
    id: 'test-hustler-id',
    firebase_uid: '7GUnkBFStzUy8Q9wtyY51lB96Vo2',
    email: 'hustler_test@hustlexp.com',
    name: 'Test Hustler',
    role: 'hustler',
    created_at: new Date(),
    updated_at: new Date(),
});

// ============================================
// User Service
// ============================================

class UserServiceClass {
    private userCache = new Map<string, DbUser>();
    private cacheExpiry = new Map<string, number>();
    private CACHE_TTL_MS = 60000; // 1 minute

    /**
     * Get user by Firebase UID - PRIMARY LOOKUP METHOD
     */
    async getByFirebaseUid(firebaseUid: string): Promise<DbUser | null> {
        // Check cache first
        const cached = this.getFromCache(firebaseUid);
        if (cached) return cached;

        // Try database
        if (isDatabaseAvailable() && sql) {
            try {
                const result = await sql`
                    SELECT id, firebase_uid, email, name, role, created_at, updated_at
                    FROM users
                    WHERE firebase_uid = ${firebaseUid}
                    LIMIT 1
                `;

                if (result.length > 0) {
                    const user = this.mapRow(result[0]);
                    this.setCache(firebaseUid, user);
                    return user;
                }
            } catch (error) {
                serviceLogger.warn({ error, firebaseUid }, 'DB lookup failed, using fallback');
            }
        }

        // Fallback to in-memory (for development/testing)
        const fallback = fallbackUsers.get(firebaseUid);
        if (fallback) {
            serviceLogger.debug({ firebaseUid }, 'Using fallback user');
            return fallback;
        }

        return null;
    }

    /**
     * Get or create user from Firebase token data
     * Used on first login to auto-create user record
     */
    async getOrCreate(firebaseUid: string, email: string, name?: string): Promise<DbUser | null> {
        // Check if exists
        let user = await this.getByFirebaseUid(firebaseUid);
        if (user) return user;

        // Default role is 'poster' - users must explicitly become hustlers
        const defaultRole: UserRole = 'poster';
        const displayName = name || email.split('@')[0];

        if (isDatabaseAvailable() && sql) {
            try {
                const result = await sql`
                    INSERT INTO users (firebase_uid, email, name, role)
                    VALUES (${firebaseUid}, ${email}, ${displayName}, ${defaultRole})
                    ON CONFLICT (firebase_uid) DO UPDATE SET
                        email = EXCLUDED.email,
                        name = COALESCE(EXCLUDED.name, users.name),
                        updated_at = NOW()
                    RETURNING id, firebase_uid, email, name, role, created_at, updated_at
                `;

                user = this.mapRow(result[0]);
                this.setCache(firebaseUid, user);
                serviceLogger.info({ userId: user.id, email, role: user.role }, 'User created/upserted');
                return user;
            } catch (error) {
                serviceLogger.error({ error, firebaseUid, email }, 'Failed to create user');
            }
        }

        // Create in fallback
        const newUser: DbUser = {
            id: `user-${Date.now()}`,
            firebase_uid: firebaseUid,
            email,
            name: displayName,
            role: defaultRole,
            created_at: new Date(),
            updated_at: new Date(),
        };
        fallbackUsers.set(firebaseUid, newUser);
        serviceLogger.info({ firebaseUid, email }, 'User created in fallback store');
        return newUser;
    }

    /**
     * Update user role
     */
    async updateRole(firebaseUid: string, newRole: UserRole): Promise<boolean> {
        // Invalidate cache
        this.userCache.delete(firebaseUid);
        this.cacheExpiry.delete(firebaseUid);

        if (isDatabaseAvailable() && sql) {
            try {
                await sql`
                    UPDATE users
                    SET role = ${newRole}, updated_at = NOW()
                    WHERE firebase_uid = ${firebaseUid}
                `;
                serviceLogger.info({ firebaseUid, newRole }, 'User role updated in DB');
                return true;
            } catch (error) {
                serviceLogger.error({ error, firebaseUid, newRole }, 'Failed to update role in DB');
            }
        }

        // Update fallback
        const fallback = fallbackUsers.get(firebaseUid);
        if (fallback) {
            fallback.role = newRole;
            fallback.updated_at = new Date();
            serviceLogger.info({ firebaseUid, newRole }, 'User role updated in fallback');
            return true;
        }

        return false;
    }

    // ============================================
    // Legacy methods for compatibility
    // ============================================

    async getUser(userId: string): Promise<User | null> {
        // Try to find by firebase_uid first
        const dbUser = await this.getByFirebaseUid(userId);
        if (dbUser) {
            // Map poster -> client for legacy compat
            const legacyRole = dbUser.role === 'poster' ? 'client' : (dbUser.role === 'admin' ? 'client' : dbUser.role);
            return {
                id: dbUser.id,
                email: dbUser.email,
                name: dbUser.name,
                role: legacyRole as 'client' | 'hustler' | 'both',
                createdAt: dbUser.created_at,
            };
        }
        return null;
    }

    async getHustlerProfile(userId: string): Promise<HustlerProfile | null> {
        return hustlerProfiles.get(userId) || null;
    }

    // Legacy compatibility method
    async getUserStats(userId: string): Promise<{ xp: number; level: number; streak: number; tasksCompleted: number; rating: number; totalEarnings: number } | null> {
        const profile = await this.getHustlerProfile(userId);
        if (!profile) return null;

        return {
            xp: profile.xp,
            level: profile.level,
            streak: profile.streak,
            tasksCompleted: profile.completedTasks,
            rating: profile.rating,
            totalEarnings: profile.completedTasks * 35, // Mock estimate
        };
    }

    // ============================================
    // Cache helpers
    // ============================================

    private getFromCache(firebaseUid: string): DbUser | null {
        const expiry = this.cacheExpiry.get(firebaseUid);
        if (!expiry || Date.now() > expiry) {
            this.userCache.delete(firebaseUid);
            this.cacheExpiry.delete(firebaseUid);
            return null;
        }
        return this.userCache.get(firebaseUid) || null;
    }

    private setCache(firebaseUid: string, user: DbUser): void {
        this.userCache.set(firebaseUid, user);
        this.cacheExpiry.set(firebaseUid, Date.now() + this.CACHE_TTL_MS);
    }

    private mapRow(row: Record<string, unknown>): DbUser {
        return {
            id: row.id as string,
            firebase_uid: row.firebase_uid as string | null,
            email: row.email as string,
            name: row.name as string,
            role: row.role as UserRole,
            created_at: row.created_at as Date,
            updated_at: row.updated_at as Date,
        };
    }
}

export const UserService = new UserServiceClass();

