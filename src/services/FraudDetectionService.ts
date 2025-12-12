/**
 * Fraud Detection Service v2
 * 
 * Enterprise-grade fraud prevention for identity verification.
 * 
 * Features:
 * - VoIP phone detection
 * - IP reputation scoring
 * - Device fingerprint correlation
 * - Multi-account detection
 * - Email domain reputation
 * - Velocity checks
 */

import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

// Known VoIP providers (partial list - extend as needed)
const VOIP_PREFIXES = [
    '+1800', '+1888', '+1877', '+1866', '+1855', // Toll-free
    '+1900', // Premium
];

// Suspicious email domains
const SUSPICIOUS_EMAIL_DOMAINS = [
    'tempmail.com', 'guerrillamail.com', 'mailinator.com',
    '10minutemail.com', 'throwaway.email', 'temp-mail.org',
    'fakeinbox.com', 'trashmail.com', 'yopmail.com',
    'dispostable.com', 'maildrop.cc', 'getairmail.com',
];

// High-risk email domains (not blocked, but flagged)
const HIGH_RISK_EMAIL_DOMAINS = [
    'protonmail.com', 'tutanota.com', 'cock.li',
];

// VPN/Proxy detection (simplified - use MaxMind or similar for production)
const KNOWN_VPN_RANGES = [
    '104.238.', // Vultr
    '45.33.', // Linode
    '167.172.', // DigitalOcean
    '142.93.', // DigitalOcean
];

// ============================================
// TYPES
// ============================================

export interface FraudSignals {
    isVoip: boolean;
    isTempEmail: boolean;
    isHighRiskEmail: boolean;
    isVpnIp: boolean;
    isNewDevice: boolean;
    hasMultipleAccounts: boolean;
    velocityExceeded: boolean;
    deviceMismatch: boolean;
    countryMismatch: boolean;
}

export interface RiskAssessment {
    riskScore: number; // 0-100 (higher = riskier)
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    signals: FraudSignals;
    recommendation: 'allow' | 'challenge' | 'block';
    reasons: string[];
}

export interface IdentityContext {
    userId: string;
    email: string;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    trustScore: number;
    riskLevel: 'low' | 'medium' | 'high';
    riskAssessment: RiskAssessment;
    verificationAge: number; // milliseconds since verification
    isFullyVerified: boolean;
    deviceFingerprint?: string;
    countryCode?: string;
}

// ============================================
// FRAUD DETECTION FUNCTIONS
// ============================================

/**
 * Check if phone number is likely VoIP
 */
function isVoipNumber(phone: string): boolean {
    for (const prefix of VOIP_PREFIXES) {
        if (phone.startsWith(prefix)) {
            return true;
        }
    }
    // Additional heuristics could be added here
    return false;
}

/**
 * Check if email is temporary/disposable
 */
function isTempEmail(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    return SUSPICIOUS_EMAIL_DOMAINS.includes(domain);
}

/**
 * Check if email domain is high-risk
 */
function isHighRiskEmailDomain(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    return HIGH_RISK_EMAIL_DOMAINS.includes(domain);
}

/**
 * Check if IP is from known VPN/proxy
 */
function isVpnIp(ip: string): boolean {
    for (const range of KNOWN_VPN_RANGES) {
        if (ip.startsWith(range)) {
            return true;
        }
    }
    return false;
}

/**
 * Check for multiple accounts from same device/phone
 */
async function checkMultipleAccounts(
    userId: string,
    phone?: string,
    deviceFingerprint?: string
): Promise<{ hasMultiple: boolean; count: number }> {
    if (!isDatabaseAvailable() || !sql) {
        return { hasMultiple: false, count: 0 };
    }

    try {
        // Check by phone
        if (phone) {
            const phoneRows = await sql`
                SELECT COUNT(DISTINCT user_id) as count FROM users_identity
                WHERE phone = ${phone} AND user_id != ${userId}::uuid
            `;
            const phoneCount = parseInt(phoneRows[0]?.count || '0', 10);
            if (phoneCount > 0) {
                return { hasMultiple: true, count: phoneCount + 1 };
            }
        }

        // Check by device fingerprint
        if (deviceFingerprint) {
            const deviceRows = await sql`
                SELECT COUNT(DISTINCT user_id) as count FROM users_identity
                WHERE device_fingerprint = ${deviceFingerprint} AND user_id != ${userId}::uuid
            `;
            const deviceCount = parseInt(deviceRows[0]?.count || '0', 10);
            if (deviceCount > 0) {
                return { hasMultiple: true, count: deviceCount + 1 };
            }
        }

        return { hasMultiple: false, count: 1 };
    } catch (error) {
        serviceLogger.error({ error }, 'Multi-account check failed');
        return { hasMultiple: false, count: 0 };
    }
}

/**
 * Check velocity (rate of verification attempts)
 */
async function checkVelocity(
    email: string,
    phone?: string,
    ip?: string
): Promise<boolean> {
    if (!isDatabaseAvailable() || !sql) {
        return false;
    }

    try {
        // More than 5 verification attempts in last hour = velocity exceeded
        const rows = await sql`
            SELECT COUNT(*) as count FROM verification_attempts
            WHERE (target = ${email} OR target = ${phone} OR ip_address = ${ip})
              AND created_at > NOW() - INTERVAL '1 hour'
        `;
        const count = parseInt(rows[0]?.count || '0', 10);
        return count > 5;
    } catch (error) {
        return false;
    }
}

// ============================================
// MAIN FRAUD DETECTION SERVICE
// ============================================

class FraudDetectionServiceClass {
    /**
     * Assess fraud risk for a verification attempt
     */
    async assessRisk(
        userId: string,
        email: string,
        phone?: string,
        ip?: string,
        deviceFingerprint?: string
    ): Promise<RiskAssessment> {
        const signals: FraudSignals = {
            isVoip: phone ? isVoipNumber(phone) : false,
            isTempEmail: isTempEmail(email),
            isHighRiskEmail: isHighRiskEmailDomain(email),
            isVpnIp: ip ? isVpnIp(ip) : false,
            isNewDevice: true, // Assume new until proven otherwise
            hasMultipleAccounts: false,
            velocityExceeded: false,
            deviceMismatch: false,
            countryMismatch: false,
        };

        const reasons: string[] = [];
        let riskScore = 0;

        // VoIP detection (+30 risk)
        if (signals.isVoip) {
            riskScore += 30;
            reasons.push('VoIP phone number detected');
        }

        // Temp email (+50 risk)
        if (signals.isTempEmail) {
            riskScore += 50;
            reasons.push('Temporary/disposable email domain');
        }

        // High-risk email (+15 risk)
        if (signals.isHighRiskEmail) {
            riskScore += 15;
            reasons.push('High-privacy email domain');
        }

        // VPN IP (+20 risk)
        if (signals.isVpnIp) {
            riskScore += 20;
            reasons.push('VPN/proxy IP detected');
        }

        // Multi-account check (+40 risk)
        const multiCheck = await checkMultipleAccounts(userId, phone, deviceFingerprint);
        signals.hasMultipleAccounts = multiCheck.hasMultiple;
        if (signals.hasMultipleAccounts) {
            riskScore += 40;
            reasons.push(`Multiple accounts detected (${multiCheck.count})`);
        }

        // Velocity check (+25 risk)
        signals.velocityExceeded = await checkVelocity(email, phone, ip);
        if (signals.velocityExceeded) {
            riskScore += 25;
            reasons.push('Unusual verification velocity');
        }

        // Determine risk level
        let riskLevel: RiskAssessment['riskLevel'];
        let recommendation: RiskAssessment['recommendation'];

        if (riskScore >= 70) {
            riskLevel = 'critical';
            recommendation = 'block';
        } else if (riskScore >= 50) {
            riskLevel = 'high';
            recommendation = 'challenge';
        } else if (riskScore >= 25) {
            riskLevel = 'medium';
            recommendation = 'challenge';
        } else {
            riskLevel = 'low';
            recommendation = 'allow';
        }

        const assessment: RiskAssessment = {
            riskScore,
            riskLevel,
            signals,
            recommendation,
            reasons,
        };

        // Log for monitoring
        serviceLogger.info({
            userId,
            riskScore,
            riskLevel,
            recommendation,
            signalCount: reasons.length,
        }, 'Fraud risk assessment');

        return assessment;
    }

    /**
     * Get full identity context for AI onboarding
     */
    async getIdentityContext(userId: string): Promise<IdentityContext | null> {
        if (!isDatabaseAvailable() || !sql) {
            return null;
        }

        try {
            const rows = await sql`
                SELECT 
                    u.id as user_id,
                    u.email,
                    COALESCE(u.email_verified, false) as email_verified,
                    COALESCE(u.phone_verified, false) as phone_verified,
                    u.email_verified_at,
                    u.phone_verified_at,
                    COALESCE(u.trust_score, 0) as trust_score,
                    COALESCE(u.verification_status, 'unverified') as verification_status,
                    iv.phone,
                    iv.device_fingerprint
                FROM users u
                LEFT JOIN identity_verification iv ON iv.user_id = u.id
                WHERE u.id = ${userId}::uuid OR u.firebase_uid = ${userId}
                LIMIT 1
            `;

            if (rows.length === 0) {
                return null;
            }

            const row = rows[0] as any;

            // Calculate verification age
            const verifiedAt = row.phone_verified_at || row.email_verified_at;
            const verificationAge = verifiedAt
                ? Date.now() - new Date(verifiedAt).getTime()
                : 0;

            // Get risk assessment
            const riskAssessment = await this.assessRisk(
                userId,
                row.email,
                row.phone,
                undefined, // IP not stored in users
                row.device_fingerprint
            );

            // Determine risk level from trust score
            const trustScore = row.trust_score || 0;
            let riskLevel: 'low' | 'medium' | 'high';
            if (trustScore >= 70) {
                riskLevel = 'low';
            } else if (trustScore >= 40) {
                riskLevel = 'medium';
            } else {
                riskLevel = 'high';
            }

            return {
                userId: row.user_id,
                email: row.email,
                phone: row.phone,
                emailVerified: row.email_verified,
                phoneVerified: row.phone_verified,
                emailVerifiedAt: row.email_verified_at,
                phoneVerifiedAt: row.phone_verified_at,
                trustScore,
                riskLevel,
                riskAssessment,
                verificationAge,
                isFullyVerified: row.email_verified && row.phone_verified,
                deviceFingerprint: row.device_fingerprint,
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to get identity context');
            return null;
        }
    }

    /**
     * Update trust score based on behavior
     */
    async updateTrustScore(
        userId: string,
        adjustment: number,
        reason: string
    ): Promise<number> {
        if (!isDatabaseAvailable() || !sql) {
            return 0;
        }

        try {
            const rows = await sql`
                UPDATE users
                SET trust_score = GREATEST(0, LEAST(100, COALESCE(trust_score, 50) + ${adjustment})),
                    updated_at = NOW()
                WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
                RETURNING trust_score
            `;

            const newScore = rows[0]?.trust_score || 50;

            serviceLogger.info({
                userId,
                adjustment,
                newScore,
                reason,
            }, 'Trust score updated');

            return newScore;
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to update trust score');
            return 0;
        }
    }

    /**
     * Record fraud signal for analysis
     */
    async recordFraudSignal(
        userId: string,
        signalType: string,
        metadata: Record<string, any>
    ): Promise<void> {
        if (!isDatabaseAvailable() || !sql) return;

        try {
            await sql`
                INSERT INTO identity_events (user_id, event_type, channel, metadata)
                VALUES (${userId}::uuid, ${`fraud_signal:${signalType}`}, 'system', ${JSON.stringify(metadata)})
            `;
        } catch (error) {
            serviceLogger.error({ error }, 'Failed to record fraud signal');
        }
    }
}

export const FraudDetectionService = new FraudDetectionServiceClass();
