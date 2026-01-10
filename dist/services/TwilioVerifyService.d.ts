/**
 * Twilio Verify Service
 *
 * Integrates with Twilio Verify API for SMS verification.
 * Uses Twilio's built-in rate limiting, fraud detection, and delivery.
 */
interface VerifySendResult {
    success: boolean;
    sid?: string;
    error?: string;
    status?: string;
}
interface VerifyCheckResult {
    valid: boolean;
    status?: string;
    error?: string;
}
declare class TwilioVerifyServiceClass {
    /**
     * Send SMS verification code via Twilio Verify
     */
    sendVerification(phone: string, channel?: 'sms' | 'call'): Promise<VerifySendResult>;
    /**
     * Check verification code via Twilio Verify
     */
    checkVerification(phone: string, code: string): Promise<VerifyCheckResult>;
    /**
     * Check if Twilio is configured
     */
    isConfigured(): boolean;
}
export declare const TwilioVerifyService: TwilioVerifyServiceClass;
export type { VerifySendResult, VerifyCheckResult };
//# sourceMappingURL=TwilioVerifyService.d.ts.map