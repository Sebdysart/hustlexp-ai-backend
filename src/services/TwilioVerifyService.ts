/**
 * Twilio Verify Service
 * 
 * Integrates with Twilio Verify API for SMS verification.
 * Uses Twilio's built-in rate limiting, fraud detection, and delivery.
 */

import twilio from 'twilio';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || 'VA820332d36bd0ecb6c536a9397d565231';

// ============================================
// TYPES
// ============================================

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

// ============================================
// TWILIO CLIENT
// ============================================

let twilioClient: twilio.Twilio | null = null;

function getClient(): twilio.Twilio | null {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        serviceLogger.warn('Twilio credentials not configured');
        return null;
    }

    if (!twilioClient) {
        twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }

    return twilioClient;
}

// ============================================
// TWILIO VERIFY SERVICE
// ============================================

class TwilioVerifyServiceClass {
    /**
     * Send SMS verification code via Twilio Verify
     */
    async sendVerification(phone: string, channel: 'sms' | 'call' = 'sms'): Promise<VerifySendResult> {
        const client = getClient();

        if (!client) {
            serviceLogger.warn({ phone }, 'Twilio not configured - using dev mode');
            return {
                success: false,
                error: 'SMS service not configured',
            };
        }

        try {
            const verification = await client.verify.v2
                .services(TWILIO_VERIFY_SERVICE_SID)
                .verifications.create({
                    to: phone,
                    channel: channel,
                });

            serviceLogger.info({
                phone,
                sid: verification.sid,
                status: verification.status,
            }, 'Twilio verification sent');

            return {
                success: true,
                sid: verification.sid,
                status: verification.status,
            };
        } catch (error: any) {
            serviceLogger.error({ error, phone }, 'Twilio verification send failed');

            // Handle specific Twilio errors
            if (error.code === 60203) {
                return { success: false, error: 'Max send attempts reached. Try again later.' };
            }
            if (error.code === 60200) {
                return { success: false, error: 'Invalid phone number format' };
            }
            if (error.code === 60205) {
                return { success: false, error: 'SMS not available to this number' };
            }

            return {
                success: false,
                error: error.message || 'Failed to send verification',
            };
        }
    }

    /**
     * Check verification code via Twilio Verify
     */
    async checkVerification(phone: string, code: string): Promise<VerifyCheckResult> {
        const client = getClient();

        if (!client) {
            serviceLogger.warn({ phone }, 'Twilio not configured - using dev mode');
            return {
                valid: false,
                error: 'SMS service not configured',
            };
        }

        try {
            const verificationCheck = await client.verify.v2
                .services(TWILIO_VERIFY_SERVICE_SID)
                .verificationChecks.create({
                    to: phone,
                    code: code,
                });

            serviceLogger.info({
                phone,
                status: verificationCheck.status,
                valid: verificationCheck.valid,
            }, 'Twilio verification check');

            return {
                valid: verificationCheck.status === 'approved',
                status: verificationCheck.status,
            };
        } catch (error: any) {
            serviceLogger.error({ error, phone }, 'Twilio verification check failed');

            // Handle specific errors
            if (error.code === 60202) {
                return { valid: false, error: 'Max check attempts reached' };
            }
            if (error.code === 20404) {
                return { valid: false, error: 'No pending verification found' };
            }

            return {
                valid: false,
                error: error.message || 'Verification check failed',
            };
        }
    }

    /**
     * Check if Twilio is configured
     */
    isConfigured(): boolean {
        return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID);
    }
}

export const TwilioVerifyService = new TwilioVerifyServiceClass();
export type { VerifySendResult, VerifyCheckResult };
