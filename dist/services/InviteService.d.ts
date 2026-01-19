/**
 * Invite Service - Phase F (Beta Guardrails)
 *
 * Controls access to Seattle Beta:
 * - Invite codes
 * - City caps
 * - Beta mode enforcement
 */
export type InviteRole = 'hustler' | 'poster' | 'both';
export interface BetaInvite {
    id: string;
    code: string;
    role: InviteRole;
    cityId?: string;
    maxUses: number;
    uses: number;
    expiresAt?: Date;
    createdBy?: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface ValidationResult {
    valid: boolean;
    reason?: string;
    invite?: BetaInvite;
}
export interface CapCheckResult {
    allowed: boolean;
    reason?: string;
    current: number;
    max: number;
}
declare class InviteServiceClass {
    /**
     * Validate an invite code
     */
    validate(code: string, role: InviteRole, cityId?: string): ValidationResult;
    /**
     * Consume an invite code
     */
    consume(code: string, userId: string): boolean;
    /**
     * Check if city is at capacity
     */
    checkCityCap(cityId: string, role: 'hustler' | 'poster'): CapCheckResult;
    /**
     * Register user as active in city
     */
    registerActiveUser(cityId: string, userId: string, role: 'hustler' | 'poster'): void;
    /**
     * Deactivate user in city
     */
    deactivateUser(cityId: string, userId: string, role: 'hustler' | 'poster'): void;
    /**
     * Check if signup is allowed
     */
    checkSignupAllowed(role: 'hustler' | 'poster', cityId: string, inviteCode?: string): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Create a new invite code
     */
    createInvite(code: string, role: InviteRole, options?: {
        cityId?: string;
        maxUses?: number;
        expiresAt?: Date;
        createdBy?: string;
    }): BetaInvite;
    /**
     * Get all invites
     */
    getAllInvites(): BetaInvite[];
    /**
     * Get invite by code
     */
    getInvite(code: string): BetaInvite | undefined;
    /**
     * Get city capacity stats
     */
    getCityStats(cityId: string): {
        hustlers: number;
        posters: number;
        caps: {
            hustler: number;
            poster: number;
        };
    };
    /**
     * Get sample invite row
     */
    getSampleRow(): BetaInvite;
}
export declare const InviteService: InviteServiceClass;
export {};
//# sourceMappingURL=InviteService.d.ts.map