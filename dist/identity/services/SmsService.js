/**
 * Twilio SMS/Verify Service
 */
import twilio from 'twilio';
import { serviceLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { canSendRealSms } from '../../config/safety.js';
const TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = env.TWILIO_VERIFY_SERVICE_SID;
// Check if Twilio is configured
const isTwilioConfigured = !!TWILIO_ACCOUNT_SID && !!TWILIO_AUTH_TOKEN && !!TWILIO_VERIFY_SERVICE_SID;
if (!isTwilioConfigured) {
    serviceLogger.warn('TWILIO keys not set - SMS disabled');
}
const client = isTwilioConfigured ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
/**
 * Send verification code via Twilio Verify
 */
export async function sendVerificationSms(phone) {
    if (!client) {
        serviceLogger.info({ phone }, 'SMS CODE: Check logs (DEV MODE)');
        return { success: true, sid: 'dev-mode' };
    }
    try {
        // Check for VoIP numbers (optional - requires Twilio Lookup)
        let isVoip = false;
        // SAFETY: Check environment
        if (!canSendRealSms()) {
            serviceLogger.info({ phone }, 'Fake SMS sent (Staging/Local)');
            return { success: true, sid: 'fake-sms-staging' };
        }
        try {
            const lookup = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
            isVoip = lookup.lineTypeIntelligence?.type === 'voip';
            if (isVoip) {
                serviceLogger.warn({ phone }, 'VoIP number detected');
            }
        }
        catch (lookupError) {
            // Lookup may fail if not enabled - continue anyway
        }
        if (!TWILIO_VERIFY_SERVICE_SID)
            throw new Error('TWILIO_VERIFY_SERVICE_SID missing');
        const verification = await client.verify.v2
            .services(TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({
            to: phone,
            channel: 'sms',
        });
        serviceLogger.info({
            phone,
            sid: verification.sid,
            status: verification.status,
        }, 'Twilio verification sent');
        return {
            success: true,
            sid: verification.sid,
            isVoip,
        };
    }
    catch (error) {
        serviceLogger.error({ error, phone }, 'Twilio send failed');
        // Handle specific errors
        if (error.code === 60203) {
            return { success: false, error: 'Max send attempts reached' };
        }
        if (error.code === 60200) {
            return { success: false, error: 'Invalid phone number' };
        }
        return { success: false, error: error.message };
    }
}
/**
 * Check verification code via Twilio Verify
 */
export async function checkVerificationSms(phone, code) {
    if (!client) {
        serviceLogger.warn({ phone }, 'SMS verification in dev mode');
        return { valid: false, error: 'SMS service not configured' };
    }
    try {
        if (!TWILIO_VERIFY_SERVICE_SID)
            throw new Error('TWILIO_VERIFY_SERVICE_SID missing');
        const check = await client.verify.v2
            .services(TWILIO_VERIFY_SERVICE_SID)
            .verificationChecks.create({
            to: phone,
            code,
        });
        serviceLogger.info({
            phone,
            status: check.status,
            valid: check.valid,
        }, 'Twilio verification check');
        return {
            valid: check.status === 'approved',
            status: check.status,
        };
    }
    catch (error) {
        serviceLogger.error({ error, phone }, 'Twilio check failed');
        if (error.code === 60202) {
            return { valid: false, error: 'Max check attempts reached' };
        }
        if (error.code === 20404) {
            return { valid: false, error: 'No pending verification' };
        }
        return { valid: false, error: error.message };
    }
}
export function isSmsServiceConfigured() {
    return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
}
//# sourceMappingURL=SmsService.js.map