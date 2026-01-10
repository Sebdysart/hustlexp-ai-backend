interface SendEmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
export declare function sendVerificationEmail(to: string, code: string): Promise<SendEmailResult>;
export declare function isEmailServiceConfigured(): boolean;
export {};
//# sourceMappingURL=EmailService.d.ts.map