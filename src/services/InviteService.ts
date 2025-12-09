/**
 * Invite Service - Phase F (Beta Guardrails)
 * 
 * Controls access to Seattle Beta:
 * - Invite codes
 * - City caps
 * - Beta mode enforcement
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { FeatureFlagService } from './FeatureFlagService.js';
import { RulesService } from './RulesService.js';
import { EventLogger } from '../utils/EventLogger.js';

// ============================================
// Types
// ============================================

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

// ============================================
// In-memory store (syncs to DB)
// ============================================

const invites = new Map<string, BetaInvite>();
const usedInvites = new Map<string, string[]>(); // code -> [userIds who used it]

// Track active users per city per role
const activeUsers = new Map<string, { hustlers: Set<string>; posters: Set<string> }>();

// Seed some test invite codes
const SEED_INVITES: Omit<BetaInvite, 'createdAt' | 'updatedAt'>[] = [
    { id: 'inv_seattle_beta', code: 'SEATTLE-BETA-2024', role: 'both', cityId: 'city_seattle', maxUses: 100, uses: 0 },
    { id: 'inv_hustler_vip', code: 'HUSTLER-VIP', role: 'hustler', cityId: 'city_seattle', maxUses: 25, uses: 0 },
    { id: 'inv_poster_early', code: 'POSTER-EARLY', role: 'poster', cityId: 'city_seattle', maxUses: 25, uses: 0 },
];

for (const invite of SEED_INVITES) {
    invites.set(invite.code.toUpperCase(), { ...invite, createdAt: new Date(), updatedAt: new Date() });
}

// Initialize Seattle active users
activeUsers.set('city_seattle', { hustlers: new Set(), posters: new Set() });

// ============================================
// Service Class
// ============================================

class InviteServiceClass {
    // ============================================
    // Invite Validation
    // ============================================

    /**
     * Validate an invite code
     */
    validate(code: string, role: InviteRole, cityId?: string): ValidationResult {
        const normalizedCode = code.toUpperCase().trim();
        const invite = invites.get(normalizedCode);

        if (!invite) {
            return { valid: false, reason: 'INVALID_CODE' };
        }

        // Check if expired
        if (invite.expiresAt && invite.expiresAt < new Date()) {
            return { valid: false, reason: 'EXPIRED' };
        }

        // Check uses
        if (invite.uses >= invite.maxUses) {
            return { valid: false, reason: 'MAX_USES_REACHED' };
        }

        // Check role match
        if (invite.role !== 'both' && invite.role !== role) {
            return { valid: false, reason: 'ROLE_MISMATCH' };
        }

        // Check city match if invite is city-specific
        if (invite.cityId && cityId && invite.cityId !== cityId) {
            return { valid: false, reason: 'CITY_MISMATCH' };
        }

        return { valid: true, invite };
    }

    /**
     * Consume an invite code
     */
    consume(code: string, userId: string): boolean {
        const normalizedCode = code.toUpperCase().trim();
        const invite = invites.get(normalizedCode);

        if (!invite) return false;

        // Check if user already used this code
        const users = usedInvites.get(normalizedCode) || [];
        if (users.includes(userId)) {
            return false; // Already used by this user
        }

        // Increment uses
        invite.uses++;
        invite.updatedAt = new Date();
        invites.set(normalizedCode, invite);

        // Track user
        users.push(userId);
        usedInvites.set(normalizedCode, users);

        serviceLogger.info({ code: normalizedCode, userId, uses: invite.uses }, 'Invite consumed');

        EventLogger.logEvent({
            eventType: 'custom',
            userId,
            source: 'backend',
            metadata: { type: 'invite_consumed', code: normalizedCode },
        });

        return true;
    }

    // ============================================
    // City Caps
    // ============================================

    /**
     * Check if city is at capacity
     */
    checkCityCap(cityId: string, role: 'hustler' | 'poster'): CapCheckResult {
        const capKey = role === 'hustler' ? 'max_active_hustlers_per_city' : 'max_active_posters_per_city';
        const maxCap = RulesService.getNumber(cityId, capKey, 500); // Default 500

        const cityUsers = activeUsers.get(cityId);
        const current = role === 'hustler'
            ? (cityUsers?.hustlers.size || 0)
            : (cityUsers?.posters.size || 0);

        if (current >= maxCap) {
            return {
                allowed: false,
                reason: 'CITY_AT_CAPACITY',
                current,
                max: maxCap,
            };
        }

        return { allowed: true, current, max: maxCap };
    }

    /**
     * Register user as active in city
     */
    registerActiveUser(cityId: string, userId: string, role: 'hustler' | 'poster'): void {
        if (!activeUsers.has(cityId)) {
            activeUsers.set(cityId, { hustlers: new Set(), posters: new Set() });
        }

        const cityData = activeUsers.get(cityId)!;
        if (role === 'hustler') {
            cityData.hustlers.add(userId);
        } else {
            cityData.posters.add(userId);
        }
    }

    /**
     * Deactivate user in city
     */
    deactivateUser(cityId: string, userId: string, role: 'hustler' | 'poster'): void {
        const cityData = activeUsers.get(cityId);
        if (!cityData) return;

        if (role === 'hustler') {
            cityData.hustlers.delete(userId);
        } else {
            cityData.posters.delete(userId);
        }
    }

    // ============================================
    // Beta Mode Checks
    // ============================================

    /**
     * Check if signup is allowed
     */
    checkSignupAllowed(role: 'hustler' | 'poster', cityId: string, inviteCode?: string): {
        allowed: boolean;
        reason?: string;
    } {
        // Check if beta mode is on
        const betaMode = FeatureFlagService.isEnabled('beta_mode');
        if (!betaMode) {
            // Not in beta mode, allow all
            return { allowed: true };
        }

        // Check Seattle-only
        const seattleOnly = FeatureFlagService.isEnabled('beta_seattle_only');
        if (seattleOnly && cityId !== 'city_seattle') {
            return { allowed: false, reason: 'SEATTLE_ONLY' };
        }

        // Check invite requirement
        const inviteRequired = role === 'hustler'
            ? FeatureFlagService.isEnabled('beta_hustler_invite_required')
            : FeatureFlagService.isEnabled('beta_poster_invite_required');

        if (inviteRequired) {
            if (!inviteCode) {
                return { allowed: false, reason: 'INVITE_REQUIRED' };
            }

            const validation = this.validate(inviteCode, role, cityId);
            if (!validation.valid) {
                return { allowed: false, reason: validation.reason };
            }
        }

        // Check city cap
        const capCheck = this.checkCityCap(cityId, role);
        if (!capCheck.allowed) {
            return { allowed: false, reason: 'CITY_AT_CAPACITY' };
        }

        return { allowed: true };
    }

    // ============================================
    // Admin Functions
    // ============================================

    /**
     * Create a new invite code
     */
    createInvite(
        code: string,
        role: InviteRole,
        options?: { cityId?: string; maxUses?: number; expiresAt?: Date; createdBy?: string }
    ): BetaInvite {
        const normalizedCode = code.toUpperCase().trim();

        const invite: BetaInvite = {
            id: `inv_${uuidv4()}`,
            code: normalizedCode,
            role,
            cityId: options?.cityId,
            maxUses: options?.maxUses || 10,
            uses: 0,
            expiresAt: options?.expiresAt,
            createdBy: options?.createdBy,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        invites.set(normalizedCode, invite);
        serviceLogger.info({ code: normalizedCode, role, maxUses: invite.maxUses }, 'Invite created');

        return invite;
    }

    /**
     * Get all invites
     */
    getAllInvites(): BetaInvite[] {
        return Array.from(invites.values());
    }

    /**
     * Get invite by code
     */
    getInvite(code: string): BetaInvite | undefined {
        return invites.get(code.toUpperCase().trim());
    }

    /**
     * Get city capacity stats
     */
    getCityStats(cityId: string): { hustlers: number; posters: number; caps: { hustler: number; poster: number } } {
        const cityData = activeUsers.get(cityId);

        return {
            hustlers: cityData?.hustlers.size || 0,
            posters: cityData?.posters.size || 0,
            caps: {
                hustler: RulesService.getNumber(cityId, 'max_active_hustlers_per_city', 500),
                poster: RulesService.getNumber(cityId, 'max_active_posters_per_city', 500),
            },
        };
    }

    /**
     * Get sample invite row
     */
    getSampleRow(): BetaInvite {
        return {
            id: 'inv_sample123',
            code: 'SEATTLE-BETA-2024',
            role: 'both',
            cityId: 'city_seattle',
            maxUses: 100,
            uses: 12,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
    }
}

export const InviteService = new InviteServiceClass();

// Initialize beta flags
FeatureFlagService.setFlag('beta_mode', true, 'Enable beta mode restrictions');
FeatureFlagService.setFlag('beta_seattle_only', true, 'Restrict to Seattle only');
FeatureFlagService.setFlag('beta_hustler_invite_required', true, 'Require invite code for hustlers');
FeatureFlagService.setFlag('beta_poster_invite_required', false, 'Require invite code for posters');
