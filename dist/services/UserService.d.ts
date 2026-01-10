/**
 * User Service - Database-backed user management
 *
 * Handles user CRUD and role management via Neon database.
 * Roles are stored here, NOT in Firebase custom claims.
 */
import type { User, HustlerProfile } from '../types/index.js';
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
declare class UserServiceClass {
    private userCache;
    private cacheExpiry;
    private CACHE_TTL_MS;
    /**
     * Get user by Firebase UID - PRIMARY LOOKUP METHOD
     */
    getByFirebaseUid(firebaseUid: string): Promise<DbUser | null>;
    /**
     * Get or create user from Firebase token data
     * Used on first login to auto-create user record
     */
    getOrCreate(firebaseUid: string, email: string, name?: string): Promise<DbUser | null>;
    /**
     * Update user role
     */
    updateRole(firebaseUid: string, newRole: UserRole): Promise<boolean>;
    getUser(userId: string): Promise<User | null>;
    getHustlerProfile(userId: string): Promise<HustlerProfile | null>;
    getUserStats(userId: string): Promise<{
        xp: number;
        level: number;
        streak: number;
        tasksCompleted: number;
        rating: number;
        totalEarnings: number;
    } | null>;
    private getFromCache;
    private setCache;
    private mapRow;
    /**
     * Get Stripe Connect Account ID for a user (hustler)
     */
    getStripeConnectId(internalUserId: string): Promise<string>;
}
export declare const UserService: UserServiceClass;
export {};
//# sourceMappingURL=UserService.d.ts.map