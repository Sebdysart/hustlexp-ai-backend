/**
 * Admin Denylist Service
 *
 * Redis-backed denylist for immediate admin revocation.
 * Even if a valid JWT has admin:true, if the UID is in the denylist,
 * access is blocked.
 *
 * This allows instant revocation without waiting for JWT expiry (up to 1 hour).
 *
 * Usage:
 *   - Add to denylist: AdminDenylistService.addToDenylist(uid, reason, addedBy)
 *   - Check denylist: AdminDenylistService.isDenied(uid)
 *   - Remove from denylist: AdminDenylistService.removeFromDenylist(uid)
 *   - Emergency lock: AdminDenylistService.emergencyLock(uid, reason)
 */
export interface DenylistEntry {
    uid: string;
    reason: string;
    addedBy: string;
    addedAt: string;
    expiresAt: string | null;
    isEmergency: boolean;
}
declare class AdminDenylistServiceClass {
    /**
     * Check if Redis is available for denylist operations
     */
    isAvailable(): boolean;
    /**
     * Check if a UID is denied (blocked from admin access)
     * CRITICAL: This is called on EVERY admin endpoint
     */
    isDenied(uid: string): Promise<boolean>;
    /**
     * Add a UID to the denylist
     * Use this for normal admin revocation
     */
    addToDenylist(uid: string, reason: string, addedBy: string, ttlSeconds?: number): Promise<boolean>;
    /**
     * Emergency lock - add to denylist with NO expiry
     * Use this when an admin account is compromised
     */
    emergencyLock(uid: string, reason: string, lockedBy?: string): Promise<boolean>;
    /**
     * Remove a UID from the denylist
     * Use with caution - only after confirming identity
     */
    removeFromDenylist(uid: string, removedBy: string): Promise<boolean>;
    /**
     * Get details of a denylist entry
     */
    getEntry(uid: string): Promise<DenylistEntry | null>;
    /**
     * List all denied UIDs
     */
    listAll(): Promise<string[]>;
    /**
     * Get count of denied UIDs
     */
    count(): Promise<number>;
}
export declare const AdminDenylistService: AdminDenylistServiceClass;
export {};
//# sourceMappingURL=AdminDenylistService.d.ts.map