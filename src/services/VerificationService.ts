/**
 * HIVS — HustleXP Identity Verification Service
 * 
 * Email + Phone verification BEFORE AI onboarding.
 * Prevents fake users, fraud, and multi-account abuse.
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    codeLength: 6,
    codeTtlMs: 10 * 60 * 1000, // 10 minutes
    maxAttempts: 5,
    lockoutMs: 30 * 60 * 1000, // 30 minutes
    emailRateLimitMs: 30 * 1000, // 30 seconds between sends
    smsRateLimitMs: 60 * 1000, // 60 seconds between sends
    maxSendsPerHour: 3,
};

// ============================================
// TYPES
// ============================================

interface VerificationStatus {
    userId: string;
    email: string;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    isLocked: boolean;
    canProceedToOnboarding: boolean;
}

interface SendCodeResult {
    success: boolean;
    error?: string;
    code?: 'RATE_LIMITED' | 'LOCKED' | 'ALREADY_VERIFIED' | 'SEND_FAILED' | 'EMAIL_NOT_VERIFIED';
    retryAfterMs?: number;
    // Debug info for developers
    _debug?: {
        reason: string;
        environment: string;
        smsMode: 'real' | 'fake' | 'disabled';
        twilioConfigured: boolean;
        emailVerified?: boolean;
    };
}

interface VerifyCodeResult {
    verified: boolean;
    error?: string;
    code?: 'INVALID_CODE' | 'EXPIRED' | 'LOCKED' | 'NOT_FOUND';
    next?: 'phone' | 'ai_onboarding';
    attemptsRemaining?: number;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
}

function normalizePhone(phone: string): string {
    // Convert to E.164 format
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned.startsWith('1') && cleaned.length === 10) {
        cleaned = '1' + cleaned;
    }
    return '+' + cleaned;
}

// ============================================
// VERIFICATION SERVICE CLASS
// ============================================

class VerificationServiceClass {
    /**
     * Get verification status for a user
     */
    async getStatus(userId: string): Promise<VerificationStatus | null> {
        if (!isDatabaseAvailable() || !sql) {
            serviceLogger.warn('Database unavailable for verification');
            return null;
        }

        try {
            const rows = await sql`
                SELECT * FROM identity_verification WHERE user_id = ${userId}::uuid
            `;

            if (rows.length === 0) {
                return null;
            }

            const record = rows[0] as any;
            const isLocked = record.locked_until && new Date(record.locked_until) > new Date();

            return {
                userId: record.user_id,
                email: record.email,
                phone: record.phone,
                emailVerified: record.email_verified,
                phoneVerified: record.phone_verified,
                emailVerifiedAt: record.email_verified_at,
                phoneVerifiedAt: record.phone_verified_at,
                isLocked,
                canProceedToOnboarding: record.email_verified && record.phone_verified,
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to get verification status');
            return null;
        }
    }

    /**
     * Initialize verification for a new user
     */
    async initializeVerification(userId: string, email: string, phone?: string): Promise<void> {
        if (!isDatabaseAvailable() || !sql) return;

        try {
            await sql`
                INSERT INTO identity_verification (user_id, email, phone)
                VALUES (${userId}::uuid, ${normalizeEmail(email)}, ${phone ? normalizePhone(phone) : null})
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    phone = EXCLUDED.phone,
                    updated_at = NOW()
            `;
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to initialize verification');
        }
    }

    /**
     * Send email verification code
     */
    async sendEmailCode(userId: string, email: string, ip?: string): Promise<SendCodeResult> {
        const normalizedEmail = normalizeEmail(email);

        // Check rate limit
        const canSend = await this.checkRateLimit(userId, 'email');
        if (!canSend.allowed) {
            return {
                success: false,
                error: 'Please wait before requesting another code',
                code: 'RATE_LIMITED',
                retryAfterMs: canSend.retryAfterMs,
            };
        }

        // Check if already verified
        const status = await this.getStatus(userId);
        if (status?.emailVerified) {
            return {
                success: false,
                error: 'Email already verified',
                code: 'ALREADY_VERIFIED',
            };
        }

        // Check if locked
        if (status?.isLocked) {
            return {
                success: false,
                error: 'Account temporarily locked due to too many attempts',
                code: 'LOCKED',
            };
        }

        // Generate code
        const code = generateCode();
        const codeHash = hashCode(code);
        const expiresAt = new Date(Date.now() + CONFIG.codeTtlMs);

        try {
            if (!sql) throw new Error('Database unavailable');
            await sql`
                INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address)
                VALUES (${userId}::uuid, 'email', ${normalizedEmail}, ${codeHash}, ${expiresAt}, ${ip || null})
            `;

            // Initialize or update verification record
            await this.initializeVerification(userId, normalizedEmail);

            // TODO: Integrate with SendGrid/Postmark
            // For now, log the code (DEVELOPMENT ONLY)
            serviceLogger.info({ userId, email: normalizedEmail, code }, 'EMAIL VERIFICATION CODE (DEV)');

            return { success: true };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to send email code');
            return { success: false, error: 'Failed to send code', code: 'SEND_FAILED' };
        }
    }

    /**
     * Verify email code
     */
    async verifyEmailCode(userId: string, email: string, code: string): Promise<VerifyCodeResult> {
        const normalizedEmail = normalizeEmail(email);
        const codeHash = hashCode(code);

        if (!isDatabaseAvailable() || !sql) {
            return { verified: false, error: 'Service unavailable' };
        }

        try {
            // Get latest attempt
            const attempts = await sql`
                SELECT * FROM verification_attempts
                WHERE user_id = ${userId}::uuid
                  AND channel = 'email'
                  AND target = ${normalizedEmail}
                  AND expires_at > NOW()
                  AND success = false
                ORDER BY created_at DESC
                LIMIT 1
            `;

            if (attempts.length === 0) {
                return { verified: false, error: 'No pending verification', code: 'NOT_FOUND' };
            }

            const attempt = attempts[0] as any;

            // Increment attempt count
            await sql`
                UPDATE verification_attempts
                SET attempt_count = attempt_count + 1, last_attempt_at = NOW()
                WHERE id = ${attempt.id}::uuid
            `;

            // Check code
            if (attempt.code_hash !== codeHash) {
                const attemptsRemaining = CONFIG.maxAttempts - (attempt.attempt_count + 1);

                // Lock account if too many attempts
                if (attemptsRemaining <= 0) {
                    await this.lockAccount(userId);
                    return { verified: false, error: 'Too many attempts', code: 'LOCKED' };
                }

                return {
                    verified: false,
                    error: 'Invalid code',
                    code: 'INVALID_CODE',
                    attemptsRemaining,
                };
            }

            // Mark as verified
            await sql`
                UPDATE verification_attempts SET success = true, verified_at = NOW()
                WHERE id = ${attempt.id}::uuid
            `;

            await sql`
                UPDATE identity_verification
                SET email_verified = true, email_verified_at = NOW(), failed_attempts = 0, updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            serviceLogger.info({ userId, email: normalizedEmail }, 'Email verified successfully');

            return { verified: true, next: 'phone' };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to verify email code');
            return { verified: false, error: 'Verification failed' };
        }
    }

    /**
     * Send SMS verification code
     * Returns explicit debug info to help diagnose delivery issues
     */
    async sendSmsCode(userId: string, phone: string, ip?: string): Promise<SendCodeResult> {
        const normalizedPhone = normalizePhone(phone);

        // Import environment detection
        const { env } = await import('../config/env.js');
        const { canSendRealSms } = await import('../config/safety.js');
        const { TwilioVerifyService } = await import('./TwilioVerifyService.js');

        const twilioConfigured = TwilioVerifyService.isConfigured();
        const smsAllowed = canSendRealSms();
        const currentEnv = env.mode;

        // Determine SMS mode for debug output
        let smsMode: 'real' | 'fake' | 'disabled' = 'disabled';
        if (twilioConfigured && smsAllowed) {
            smsMode = 'real';
        } else if (twilioConfigured || currentEnv !== 'production') {
            smsMode = 'fake';
        }

        // Check email is verified first
        const status = await this.getStatus(userId);
        if (!status?.emailVerified) {
            serviceLogger.warn({ userId, phone: normalizedPhone }, 'SMS blocked: email not verified');
            return {
                success: false,
                error: 'Email must be verified before phone verification',
                code: 'EMAIL_NOT_VERIFIED',
                _debug: {
                    reason: 'Email verification required first. Complete email verification, then retry phone.',
                    environment: currentEnv,
                    smsMode,
                    twilioConfigured,
                    emailVerified: false,
                },
            };
        }

        // Check rate limit
        const canSend = await this.checkRateLimit(userId, 'sms');
        if (!canSend.allowed) {
            return {
                success: false,
                error: 'Please wait before requesting another code',
                code: 'RATE_LIMITED',
                retryAfterMs: canSend.retryAfterMs,
                _debug: {
                    reason: `Rate limited. Retry in ${Math.ceil((canSend.retryAfterMs || 0) / 1000)}s`,
                    environment: currentEnv,
                    smsMode,
                    twilioConfigured,
                    emailVerified: true,
                },
            };
        }

        // Check if already verified
        if (status?.phoneVerified) {
            return {
                success: false,
                error: 'Phone already verified',
                code: 'ALREADY_VERIFIED',
                _debug: {
                    reason: 'Phone already verified for this user. No action needed.',
                    environment: currentEnv,
                    smsMode,
                    twilioConfigured,
                    emailVerified: true,
                },
            };
        }

        const expiresAt = new Date(Date.now() + CONFIG.codeTtlMs);

        try {
            if (!sql) throw new Error('Database unavailable');

            // Determine delivery method based on environment + config
            if (twilioConfigured && smsAllowed) {
                // PRODUCTION: Real SMS via Twilio Verify
                const twilioResult = await TwilioVerifyService.sendVerification(normalizedPhone, 'sms');

                if (!twilioResult.success) {
                    serviceLogger.error({ error: twilioResult.error, userId }, 'Twilio send failed');
                    return {
                        success: false,
                        error: twilioResult.error || 'SMS send failed',
                        code: 'SEND_FAILED',
                        _debug: {
                            reason: `Twilio delivery failed: ${twilioResult.error}`,
                            environment: currentEnv,
                            smsMode: 'real',
                            twilioConfigured: true,
                            emailVerified: true,
                        },
                    };
                }

                // Log attempt (Twilio manages the code)
                await sql`
                    INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address)
                    VALUES (${userId}::uuid, 'sms', ${normalizedPhone}, 'twilio-managed', ${expiresAt}, ${ip || null})
                `;

                serviceLogger.info({ userId, phone: normalizedPhone }, 'Real SMS sent via Twilio');
            } else {
                // DEVELOPMENT/STAGING: Fake SMS - log the code
                const code = generateCode();
                const codeHash = hashCode(code);

                await sql`
                    INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address)
                    VALUES (${userId}::uuid, 'sms', ${normalizedPhone}, ${codeHash}, ${expiresAt}, ${ip || null})
                `;

                serviceLogger.info(
                    { userId, phone: normalizedPhone, code },
                    `📱 SMS VERIFICATION CODE (${currentEnv.toUpperCase()}): ${code}`
                );
            }

            // Update phone in verification record
            await sql`
                UPDATE identity_verification SET phone = ${normalizedPhone}, updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            return {
                success: true,
                _debug: {
                    reason: smsMode === 'real'
                        ? 'Real SMS sent via Twilio Verify'
                        : `Fake SMS - code logged to server console (${currentEnv} environment)`,
                    environment: currentEnv,
                    smsMode,
                    twilioConfigured,
                    emailVerified: true,
                },
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to send SMS code');
            return { success: false, error: 'Failed to send code', code: 'SEND_FAILED' };
        }
    }

    /**
     * Verify SMS code
     */
    async verifySmsCode(userId: string, phone: string, code: string): Promise<VerifyCodeResult> {
        const normalizedPhone = normalizePhone(phone);
        const codeHash = hashCode(code);

        if (!isDatabaseAvailable() || !sql) {
            return { verified: false, error: 'Service unavailable' };
        }

        try {
            // Check if we should use Twilio Verify
            const { TwilioVerifyService } = await import('./TwilioVerifyService.js');

            if (TwilioVerifyService.isConfigured()) {
                // PRODUCTION: Use Twilio Verify to check the code
                const twilioResult = await TwilioVerifyService.checkVerification(normalizedPhone, code);

                if (!twilioResult.valid) {
                    // Get latest attempt for tracking
                    const attempts = await sql`
                        SELECT * FROM verification_attempts
                        WHERE user_id = ${userId}::uuid
                          AND channel = 'sms'
                          AND target = ${normalizedPhone}
                        ORDER BY created_at DESC
                        LIMIT 1
                    `;

                    if (attempts.length > 0) {
                        const attempt = attempts[0] as any;
                        await sql`
                            UPDATE verification_attempts
                            SET attempt_count = attempt_count + 1, last_attempt_at = NOW()
                            WHERE id = ${attempt.id}::uuid
                        `;

                        const attemptsRemaining = CONFIG.maxAttempts - (attempt.attempt_count + 1);
                        if (attemptsRemaining <= 0) {
                            await this.lockAccount(userId);
                            return { verified: false, error: 'Too many attempts', code: 'LOCKED' };
                        }
                    }

                    return {
                        verified: false,
                        error: twilioResult.error || 'Invalid code',
                        code: 'INVALID_CODE',
                    };
                }

                // Twilio verified - update our records
                await sql`
                    UPDATE verification_attempts SET success = true, verified_at = NOW()
                    WHERE user_id = ${userId}::uuid AND channel = 'sms' AND target = ${normalizedPhone}
                    AND success = false
                `;

                await sql`
                    UPDATE identity_verification
                    SET phone_verified = true, phone_verified_at = NOW(), failed_attempts = 0, updated_at = NOW()
                    WHERE user_id = ${userId}::uuid
                `;

                serviceLogger.info({ userId, phone: normalizedPhone }, 'Phone verified via Twilio');
                return { verified: true, next: 'ai_onboarding' };
            }

            // DEVELOPMENT: Use local code verification
            const attempts = await sql`
                SELECT * FROM verification_attempts
                WHERE user_id = ${userId}::uuid
                  AND channel = 'sms'
                  AND target = ${normalizedPhone}
                  AND expires_at > NOW()
                  AND success = false
                ORDER BY created_at DESC
                LIMIT 1
            `;

            if (attempts.length === 0) {
                return { verified: false, error: 'No pending verification', code: 'NOT_FOUND' };
            }

            const attempt = attempts[0] as any;

            // Increment attempt count
            await sql`
                UPDATE verification_attempts
                SET attempt_count = attempt_count + 1, last_attempt_at = NOW()
                WHERE id = ${attempt.id}::uuid
            `;

            // Check code
            if (attempt.code_hash !== codeHash) {
                const attemptsRemaining = CONFIG.maxAttempts - (attempt.attempt_count + 1);

                if (attemptsRemaining <= 0) {
                    await this.lockAccount(userId);
                    return { verified: false, error: 'Too many attempts', code: 'LOCKED' };
                }

                return {
                    verified: false,
                    error: 'Invalid code',
                    code: 'INVALID_CODE',
                    attemptsRemaining,
                };
            }

            // Mark as verified
            await sql`
                UPDATE verification_attempts SET success = true, verified_at = NOW()
                WHERE id = ${attempt.id}::uuid
            `;

            await sql`
                UPDATE identity_verification
                SET phone_verified = true, phone_verified_at = NOW(), failed_attempts = 0, updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            serviceLogger.info({ userId, phone: normalizedPhone }, 'Phone verified successfully');

            return { verified: true, next: 'ai_onboarding' };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to verify SMS code');
            return { verified: false, error: 'Verification failed' };
        }
    }

    /**
     * Check if user can proceed to AI onboarding
     */
    async canStartOnboarding(userId: string): Promise<{ allowed: boolean; nextRequired?: 'email' | 'phone' }> {
        const status = await this.getStatus(userId);

        if (!status) {
            return { allowed: false, nextRequired: 'email' };
        }

        if (!status.emailVerified) {
            return { allowed: false, nextRequired: 'email' };
        }

        if (!status.phoneVerified) {
            return { allowed: false, nextRequired: 'phone' };
        }

        return { allowed: true };
    }

    /**
     * Check rate limit for sending codes
     */
    private async checkRateLimit(
        userId: string,
        channel: 'email' | 'sms'
    ): Promise<{ allowed: boolean; retryAfterMs?: number }> {
        if (!isDatabaseAvailable() || !sql) {
            return { allowed: true }; // Fail open in dev
        }

        const rateLimitMs = channel === 'email' ? CONFIG.emailRateLimitMs : CONFIG.smsRateLimitMs;

        try {
            const recentAttempts = await sql`
                SELECT sent_at FROM verification_attempts
                WHERE user_id = ${userId}::uuid
                  AND channel = ${channel}
                  AND sent_at > NOW() - INTERVAL '1 hour'
                ORDER BY sent_at DESC
            `;

            // Check per-send rate limit
            if (recentAttempts.length > 0) {
                const lastSent = new Date(recentAttempts[0].sent_at);
                const timeSince = Date.now() - lastSent.getTime();

                if (timeSince < rateLimitMs) {
                    return { allowed: false, retryAfterMs: rateLimitMs - timeSince };
                }
            }

            // Check hourly limit
            if (recentAttempts.length >= CONFIG.maxSendsPerHour) {
                return { allowed: false, retryAfterMs: 60 * 60 * 1000 };
            }

            return { allowed: true };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to check rate limit');
            return { allowed: true }; // Fail open
        }
    }

    /**
     * Lock account after too many failed attempts
     */
    private async lockAccount(userId: string): Promise<void> {
        if (!isDatabaseAvailable() || !sql) return;

        const lockedUntil = new Date(Date.now() + CONFIG.lockoutMs);

        try {
            await sql`
                UPDATE identity_verification
                SET locked_until = ${lockedUntil}, updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            serviceLogger.warn({ userId, lockedUntil }, 'Account locked due to too many attempts');
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to lock account');
        }
    }
}

export const VerificationService = new VerificationServiceClass();
export type { VerificationStatus, SendCodeResult, VerifyCodeResult };
