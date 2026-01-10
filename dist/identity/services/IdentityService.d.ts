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
declare class IdentityServiceClass {
    /**
     * Get identity status for a user
     */
    getStatus(userId: string): Promise<IdentityStatus | null>;
    /**
     * Initialize identity record for new user
     */
    initializeIdentity(userId: string, email: string): Promise<void>;
    /**
     * Send email verification code
     */
    sendEmailCode(userId: string, email: string, ip?: string): Promise<SendResult>;
    /**
     * Verify email code
     */
    verifyEmailCode(userId: string, email: string, code: string, ip?: string): Promise<VerifyResult>;
    /**
     * Send SMS verification code
     */
    sendSmsCode(userId: string, phone: string, ip?: string): Promise<SendResult>;
    /**
     * Verify SMS code
     */
    verifySmsCode(userId: string, phone: string, code: string, ip?: string): Promise<VerifyResult>;
    /**
     * Log identity event
     */
    private logEvent;
}
export declare const IdentityService: IdentityServiceClass;
export {};
//# sourceMappingURL=IdentityService.d.ts.map