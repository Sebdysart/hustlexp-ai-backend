interface SmsSendResult {
    success: boolean;
    sid?: string;
    error?: string;
    isVoip?: boolean;
}
interface SmsVerifyResult {
    valid: boolean;
    status?: string;
    error?: string;
}
/**
 * Send verification code via Twilio Verify
 */
export declare function sendVerificationSms(phone: string): Promise<SmsSendResult>;
/**
 * Check verification code via Twilio Verify
 */
export declare function checkVerificationSms(phone: string, code: string): Promise<SmsVerifyResult>;
export declare function isSmsServiceConfigured(): boolean;
export {};
//# sourceMappingURL=SmsService.d.ts.map