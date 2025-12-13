/**
 * Identity Verification Service (Merged)
 * 
 * Handles email/phone verification using internal Event Bus.
 */
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { sql } from '../../db/index.js';
import { sendVerificationEmail, isEmailServiceConfigured } from './EmailService.js';
import { sendVerificationSms, checkVerificationSms, isSmsServiceConfigured } from './SmsService.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { serviceLogger } from '../../utils/logger.js';
import { IdentityEventBus } from '../IdentityEventBus.js';

// ... (rest of imports)

function isDatabaseAvailable() {
    return !!sql;
}

// ... sendWebhook removal ...
// I will act on the whole file to be safe using multi_replace logic inside replace_file_content if feasible or just Replace the whole file content?
// The file is 450 lines. Large.
// I will use multi_replace.


// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    codeLength: 6,
    codeTtlMs: 10 * 60 * 1000, // 10 minutes
    maxAttempts: 5,
    lockoutMs: 30 * 60 * 1000, // 30 minutes
    saltRounds: 10,
};

// ============================================
// TYPES
// ============================================

export interface IdentityStatus {
    userId: string;
    email: string;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    status: 'unverified' | 'email_verified' | 'fully_verified' | 'suspended';
    isFullyVerified: boolean;
}

export interface SendResult {
    success: boolean;
    error?: string;
    code?: string;
    retryAfterMs?: number;
}

export interface VerifyResult {
    verified: boolean;
    error?: string;
    attemptsRemaining?: number;
    event?: string;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
}

function normalizePhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned.startsWith('1') && cleaned.length === 10) {
        cleaned = '1' + cleaned;
    }
    return '+' + cleaned;
}

// ============================================
// IDENTITY SERVICE CLASS
// ============================================

class IdentityServiceClass {
    /**
     * Get identity status for a user
     */
    async getStatus(userId: string): Promise<IdentityStatus | null> {
        if (!sql) return null;

        try {
            const rows = await sql`
                SELECT * FROM users_identity WHERE user_id = ${userId}::uuid
            `;

            if (rows.length === 0) return null;

            const record = rows[0] as any;
            return {
                userId: record.user_id,
                email: record.email,
                phone: record.phone,
                emailVerified: record.email_verified,
                phoneVerified: record.phone_verified,
                status: record.status,
                isFullyVerified: record.email_verified && record.phone_verified,
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to get identity status');
            return null;
        }
    }

    /**
     * Initialize identity record for new user
     */
    async initializeIdentity(userId: string, email: string): Promise<void> {
        if (!sql) return;

        try {
            await sql`
                INSERT INTO users_identity (user_id, email)
                VALUES (${userId}::uuid, ${normalizeEmail(email)})
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    updated_at = NOW()
            `;
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to initialize identity');
        }
    }

    /**
     * Send email verification code
     */
    async sendEmailCode(userId: string, email: string, ip?: string): Promise<SendResult> {
        const normalizedEmail = normalizeEmail(email);

        // Rate limit check
        const rateCheck = await checkRateLimit(`${userId}:email`, 'emailSend');
        if (!rateCheck.allowed) {
            return {
                success: false,
                error: 'Too many attempts. Please wait.',
                code: 'RATE_LIMITED',
                retryAfterMs: rateCheck.retryAfterMs,
            };
        }

        // Check existing status
        const status = await this.getStatus(userId);
        if (status?.emailVerified) {
            return { success: false, error: 'Email already verified', code: 'ALREADY_VERIFIED' };
        }

        // Generate and hash code
        const code = generateCode();
        const codeHash = await bcrypt.hash(code, CONFIG.saltRounds);
        const expiresAt = new Date(Date.now() + CONFIG.codeTtlMs);

        if (!sql) return { success: false, error: 'Database unavailable', code: 'SERVICE_ERROR' };

        try {
            // Store attempt
            await sql`
                INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address)
                VALUES (${userId}::uuid, 'email', ${normalizedEmail}, ${codeHash}, ${expiresAt}, ${ip || null})
            `;

            // Initialize identity if needed
            await this.initializeIdentity(userId, normalizedEmail);

            // Send email
            if (isEmailServiceConfigured()) {
                const result = await sendVerificationEmail(normalizedEmail, code);
                if (!result.success) {
                    return { success: false, error: result.error, code: 'SEND_FAILED' };
                }
            } else {
                serviceLogger.info({ userId, email: normalizedEmail, code }, 'EMAIL CODE (DEV)');
            }

            // Log event
            await this.logEvent(userId, 'email_code_sent', 'email', { email: normalizedEmail }, ip);

            return { success: true };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to send email code');
            return { success: false, error: 'Failed to send code', code: 'SERVICE_ERROR' };
        }
    }

    /**
     * Verify email code
     */
    async verifyEmailCode(userId: string, email: string, code: string, ip?: string): Promise<VerifyResult> {
        const normalizedEmail = normalizeEmail(email);
        if (!sql) return { verified: false, error: 'Database unavailable' };

        // Rate limit
        const rateCheck = await checkRateLimit(`${userId}:verify`, 'verify');
        if (!rateCheck.allowed) {
            return { verified: false, error: 'Too many attempts', attemptsRemaining: 0 };
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
                return { verified: false, error: 'No pending verification' };
            }

            const attempt = attempts[0] as any;

            // Increment attempt count
            await sql`
                UPDATE verification_attempts
                SET attempt_count = attempt_count + 1, last_attempt_at = NOW()
                WHERE id = ${attempt.id}::uuid
            `;

            // Verify code
            const isValid = await bcrypt.compare(code, attempt.code_hash);
            if (!isValid) {
                const remaining = CONFIG.maxAttempts - (attempt.attempt_count + 1);
                return {
                    verified: false,
                    error: 'Invalid code',
                    attemptsRemaining: Math.max(0, remaining),
                };
            }

            // Mark as verified
            await sql`UPDATE verification_attempts SET success = true, verified_at = NOW() WHERE id = ${attempt.id}::uuid`;
            await sql`
                UPDATE users_identity
                SET email_verified = true, email_verified_at = NOW(), status = 'email_verified', updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            await this.logEvent(userId, 'email_verified', 'email', { email: normalizedEmail }, ip);
            await IdentityEventBus.emit({
                type: 'email.verified',
                userId,
                timestamp: new Date().toISOString(),
                data: { email: normalizedEmail }
            });

            return { verified: true, event: 'IDENTITY_EMAIL_VERIFIED' };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to verify email');
            return { verified: false, error: 'Verification failed' };
        }
    }

    /**
     * Send SMS verification code
     */
    async sendSmsCode(userId: string, phone: string, ip?: string): Promise<SendResult> {
        const normalizedPhone = normalizePhone(phone);

        // Must have email verified first
        const status = await this.getStatus(userId);
        if (!status?.emailVerified) {
            return { success: false, error: 'Email must be verified first', code: 'EMAIL_REQUIRED' };
        }

        if (status.phoneVerified) {
            return { success: false, error: 'Phone already verified', code: 'ALREADY_VERIFIED' };
        }

        // Rate limit
        const rateCheck = await checkRateLimit(`${userId}:sms`, 'smsSend');
        if (!rateCheck.allowed) {
            return {
                success: false,
                error: 'Too many attempts. Please wait.',
                code: 'RATE_LIMITED',
                retryAfterMs: rateCheck.retryAfterMs,
            };
        }

        if (!sql) return { success: false, error: 'Database unavailable', code: 'SERVICE_ERROR' };

        try {
            const expiresAt = new Date(Date.now() + CONFIG.codeTtlMs);

            if (isSmsServiceConfigured()) {
                // Use Twilio Verify
                const result = await sendVerificationSms(normalizedPhone);
                if (!result.success) {
                    return { success: false, error: result.error, code: 'SEND_FAILED' };
                }

                await sql`
                    INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address, provider_sid, is_voip)
                    VALUES (${userId}::uuid, 'sms', ${normalizedPhone}, 'twilio-managed', ${expiresAt}, ${ip || null}, ${result.sid || null}, ${result.isVoip || false})
                `;
            } else {
                // Dev mode - generate local code
                const code = generateCode();
                const codeHash = await bcrypt.hash(code, CONFIG.saltRounds);

                await sql`
                    INSERT INTO verification_attempts (user_id, channel, target, code_hash, expires_at, ip_address)
                    VALUES (${userId}::uuid, 'sms', ${normalizedPhone}, ${codeHash}, ${expiresAt}, ${ip || null})
                `;

                serviceLogger.info({ userId, phone: normalizedPhone, code }, 'SMS CODE (DEV)');
            }

            // Update phone in identity
            await sql`UPDATE users_identity SET phone = ${normalizedPhone}, updated_at = NOW() WHERE user_id = ${userId}::uuid`;

            await this.logEvent(userId, 'sms_code_sent', 'sms', { phone: normalizedPhone }, ip);

            return { success: true };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to send SMS');
            return { success: false, error: 'Failed to send code', code: 'SERVICE_ERROR' };
        }
    }

    /**
     * Verify SMS code
     */
    async verifySmsCode(userId: string, phone: string, code: string, ip?: string): Promise<VerifyResult> {
        const normalizedPhone = normalizePhone(phone);
        if (!sql) return { verified: false, error: 'Database unavailable' };

        // Rate limit
        const rateCheck = await checkRateLimit(`${userId}:verify`, 'verify');
        if (!rateCheck.allowed) {
            return { verified: false, error: 'Too many attempts', attemptsRemaining: 0 };
        }

        try {
            if (isSmsServiceConfigured()) {
                // Use Twilio Verify
                const result = await checkVerificationSms(normalizedPhone, code);
                if (!result.valid) {
                    return { verified: false, error: result.error || 'Invalid code' };
                }
            } else {
                // Dev mode - check local hash
                const attempts = await sql`
                    SELECT * FROM verification_attempts
                    WHERE user_id = ${userId}::uuid AND channel = 'sms' AND target = ${normalizedPhone}
                      AND expires_at > NOW() AND success = false
                    ORDER BY created_at DESC LIMIT 1
                `;

                if (attempts.length === 0) {
                    return { verified: false, error: 'No pending verification' };
                }

                const attempt = attempts[0] as any;
                const isValid = await bcrypt.compare(code, attempt.code_hash);
                if (!isValid) {
                    return { verified: false, error: 'Invalid code' };
                }

                await sql`UPDATE verification_attempts SET success = true, verified_at = NOW() WHERE id = ${attempt.id}::uuid`;
            }

            // Mark fully verified
            await sql`
                UPDATE users_identity
                SET phone_verified = true, phone_verified_at = NOW(), status = 'fully_verified', updated_at = NOW()
                WHERE user_id = ${userId}::uuid
            `;

            await this.logEvent(userId, 'phone_verified', 'sms', { phone: normalizedPhone }, ip);

            await IdentityEventBus.emit({
                type: 'phone.verified',
                userId,
                timestamp: new Date().toISOString(),
                data: { phone: normalizedPhone }
            });

            await IdentityEventBus.emit({
                type: 'identity.fully_verified',
                userId,
                timestamp: new Date().toISOString(),
                data: {}
            });

            return { verified: true, event: 'IDENTITY_PHONE_VERIFIED' };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to verify SMS');
            return { verified: false, error: 'Verification failed' };
        }
    }

    /**
     * Log identity event
     */
    private async logEvent(userId: string, eventType: string, channel: string | null, metadata: any, ip?: string): Promise<void> {
        if (!sql) return;

        try {
            await sql`
                INSERT INTO identity_events (user_id, event_type, channel, metadata, ip_address)
                VALUES (${userId}::uuid, ${eventType}, ${channel}, ${JSON.stringify(metadata)}, ${ip || null})
            `;
        } catch (error) {
            serviceLogger.error({ error }, 'Failed to log event');
        }
    }

}

export const IdentityService = new IdentityServiceClass();
