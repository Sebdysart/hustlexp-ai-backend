/**
 * HIVS — HustleXP Identity Verification Service
 *
 * Email + Phone verification BEFORE AI onboarding.
 * Prevents fake users, fraud, and multi-account abuse.
 */
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
declare class VerificationServiceClass {
    /**
     * Get verification status for a user
     */
    getStatus(userId: string): Promise<VerificationStatus | null>;
    /**
     * Initialize verification for a new user
     */
    initializeVerification(userId: string, email: string, phone?: string): Promise<void>;
    /**
     * Send email verification code
     */
    sendEmailCode(userId: string, email: string, ip?: string): Promise<SendCodeResult>;
    /**
     * Verify email code
     */
    verifyEmailCode(userId: string, email: string, code: string): Promise<VerifyCodeResult>;
    /**
     * Send SMS verification code
     * Returns explicit debug info to help diagnose delivery issues
     */
    sendSmsCode(userId: string, phone: string, ip?: string): Promise<SendCodeResult>;
    /**
     * Verify SMS code
     */
    verifySmsCode(userId: string, phone: string, code: string): Promise<VerifyCodeResult>;
    /**
     * Check if user can proceed to AI onboarding
     */
    canStartOnboarding(userId: string): Promise<{
        allowed: boolean;
        nextRequired?: 'email' | 'phone';
    }>;
    /**
     * Check rate limit for sending codes
     */
    private checkRateLimit;
    /**
     * Lock account after too many failed attempts
     */
    private lockAccount;
}
export declare const VerificationService: VerificationServiceClass;
export type { VerificationStatus, SendCodeResult, VerifyCodeResult };
//# sourceMappingURL=VerificationService.d.ts.map