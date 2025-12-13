
/**
 * SendGrid Email Service
 */
import sgMail from '@sendgrid/mail';
import { serviceLogger } from '../../utils/logger.js';

import { env } from '../../config/env.js';
import { canSendRealEmail } from '../../config/safety.js';

const SENDGRID_API_KEY = env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = env.SENDGRID_FROM_EMAIL || 'verify@hustlexp.app';

if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
} else {
    serviceLogger.warn('SENDGRID_API_KEY not set - Email disabled');
}

interface SendEmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

export async function sendVerificationEmail(
    to: string,
    code: string
): Promise<SendEmailResult> {
    if (!SENDGRID_API_KEY) {
        serviceLogger.info({ to, code }, 'EMAIL CODE (DEV MODE - No API Key)');
        return { success: true, messageId: 'dev-mode-no-api-key' };
    }

    // SAFETY: Check environment to prevent sending real emails in certain environments (e.g., staging/local)
    if (!canSendRealEmail()) {
        serviceLogger.info({ to, code }, 'EMAIL CODE (DEV MODE - canSendRealEmail is false)');
        return { success: true, messageId: 'dev-mode-safety-check' };
    }

    try {
        const [response] = await sgMail.send({
            to,
            from: SENDGRID_FROM_EMAIL,
            subject: 'Your HustleXP Verification Code',
            text: `Your verification code is: ${code} \n\nThis code expires in 10 minutes.`,
            html: `
    < div style = "font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;" >
        <h2 style="color: #6366f1;" > HustleXP </h2>
            < p > Your verification code is: </p>
                < div style = "background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;" >
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1f2937;" > ${code} </span>
                        </div>
                        < p style = "color: #6b7280; font-size: 14px;" > This code expires in 10 minutes.</p>
                            < p style = "color: #6b7280; font-size: 12px;" > If you didn't request this code, please ignore this email.</p>
                                </div>
                                    `,
        });

        serviceLogger.info({ to, statusCode: response.statusCode }, 'Verification email sent');
        return { success: true, messageId: response.headers['x-message-id'] };
    } catch (error: any) {
        serviceLogger.error({ error, to }, 'Failed to send verification email');
        return { success: false, error: error.message };
    }
}

export function isEmailServiceConfigured(): boolean {
    return !!SENDGRID_API_KEY;
}
