/**
 * Identity Verification Middleware
 *
 * Gates access to protected routes based on identity verification status.
 * Must be verified (email + phone) before accessing AI onboarding.
 */
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// STATUS CHECK
// ============================================
async function getUserVerificationStatus(userId) {
    if (!isDatabaseAvailable() || !sql) {
        return null;
    }
    try {
        const rows = await sql `
            SELECT 
                COALESCE(email_verified, false) as email_verified,
                COALESCE(phone_verified, false) as phone_verified,
                COALESCE(verification_status, 'unverified') as verification_status,
                COALESCE(onboarding_unlocked, false) as onboarding_unlocked
            FROM users 
            WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
            LIMIT 1
        `;
        if (rows.length === 0) {
            return null;
        }
        const row = rows[0];
        return {
            emailVerified: row.email_verified,
            phoneVerified: row.phone_verified,
            verificationStatus: row.verification_status,
            onboardingUnlocked: row.onboarding_unlocked,
        };
    }
    catch (error) {
        serviceLogger.error({ error, userId }, 'Failed to get verification status');
        return null;
    }
}
// ============================================
// MIDDLEWARE: REQUIRE EMAIL VERIFIED
// ============================================
export async function requireEmailVerified(request, reply) {
    const userId = request.user?.uid;
    if (!userId) {
        reply.status(401).send({ error: 'Authentication required' });
        return;
    }
    const status = await getUserVerificationStatus(userId);
    if (!status?.emailVerified) {
        reply.status(403).send({
            error: 'EMAIL_NOT_VERIFIED',
            message: 'Email verification required',
            action: 'verify_email',
            ivsUrl: '/api/verify/email/send',
        });
        return;
    }
}
// ============================================
// MIDDLEWARE: REQUIRE PHONE VERIFIED
// ============================================
export async function requirePhoneVerified(request, reply) {
    const userId = request.user?.uid;
    if (!userId) {
        reply.status(401).send({ error: 'Authentication required' });
        return;
    }
    const status = await getUserVerificationStatus(userId);
    if (!status?.phoneVerified) {
        reply.status(403).send({
            error: 'PHONE_NOT_VERIFIED',
            message: 'Phone verification required',
            action: 'verify_phone',
            ivsUrl: '/api/verify/phone/send',
        });
        return;
    }
}
// ============================================
// MIDDLEWARE: REQUIRE FULLY VERIFIED (IDENTITY GATE)
// ============================================
export async function requireIdentityVerified(request, reply) {
    const userId = request.user?.uid;
    if (!userId) {
        reply.status(401).send({ error: 'Authentication required' });
        return;
    }
    const status = await getUserVerificationStatus(userId);
    if (!status) {
        reply.status(403).send({
            error: 'IDENTITY_UNKNOWN',
            message: 'User not found',
        });
        return;
    }
    if (!status.emailVerified) {
        reply.status(403).send({
            error: 'IDENTITY_UNVERIFIED',
            message: 'Identity verification required before proceeding',
            nextRequired: 'email',
            ivsUrl: '/api/verify/email/send',
        });
        return;
    }
    if (!status.phoneVerified) {
        reply.status(403).send({
            error: 'IDENTITY_UNVERIFIED',
            message: 'Identity verification required before proceeding',
            nextRequired: 'phone',
            ivsUrl: '/api/verify/phone/send',
        });
        return;
    }
    if (status.verificationStatus !== 'verified') {
        reply.status(403).send({
            error: 'IDENTITY_PENDING',
            message: 'Identity verification pending',
        });
        return;
    }
}
// ============================================
// MIDDLEWARE: REQUIRE ONBOARDING UNLOCKED
// ============================================
export async function requireOnboardingUnlocked(request, reply) {
    const userId = request.user?.uid;
    if (!userId) {
        reply.status(401).send({ error: 'Authentication required' });
        return;
    }
    const status = await getUserVerificationStatus(userId);
    if (!status?.onboardingUnlocked) {
        reply.status(403).send({
            error: 'ONBOARDING_LOCKED',
            message: 'Complete identity verification to unlock onboarding',
            emailVerified: status?.emailVerified ?? false,
            phoneVerified: status?.phoneVerified ?? false,
            nextRequired: !status?.emailVerified ? 'email' : 'phone',
        });
        return;
    }
}
// ============================================
// HELPER: GET IDENTITY CONTEXT FOR AI
// ============================================
export async function getIdentityContextForAI(userId) {
    if (!isDatabaseAvailable() || !sql) {
        return null;
    }
    try {
        const rows = await sql `
            SELECT 
                email_verified_at,
                phone_verified_at,
                COALESCE(trust_score, 0) as trust_score,
                verification_status
            FROM users 
            WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
            LIMIT 1
        `;
        if (rows.length === 0) {
            return null;
        }
        const row = rows[0];
        const trustScore = row.trust_score || 0;
        return {
            isVerified: row.verification_status === 'verified',
            emailVerifiedAt: row.email_verified_at,
            phoneVerifiedAt: row.phone_verified_at,
            trustScore,
            riskLevel: trustScore >= 70 ? 'low' : trustScore >= 40 ? 'medium' : 'high',
        };
    }
    catch (error) {
        serviceLogger.error({ error, userId }, 'Failed to get identity context');
        return null;
    }
}
//# sourceMappingURL=identityGate.js.map