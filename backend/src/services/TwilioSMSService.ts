/**
 * TwilioSMSService v1.0.0
 *
 * SYSTEM GUARANTEES: SMS Delivery via Twilio
 *
 * Provides SMS sending and phone verification via Twilio.
 * Uses lazy singleton client initialization with graceful degradation
 * when credentials are missing.
 *
 * Hard rule: SMS send is never inline on request paths - always async via sms_outbox
 *
 * @see ARCHITECTURE.md §2.6 (Notification Services)
 */

import twilio from 'twilio';
import { config } from '../config';
import { twilioBreaker } from '../middleware/circuit-breaker';
import { logger } from '../logger';

const log = logger.child({ service: 'TwilioSMSService' });

// ============================================================================
// LAZY SINGLETON CLIENT
// ============================================================================

let twilioClient: ReturnType<typeof twilio> | null = null;

/**
 * Get or create the Twilio client (lazy singleton)
 * Returns null if credentials are not configured
 */
function getClient(): ReturnType<typeof twilio> | null {
  if (twilioClient) {
    return twilioClient;
  }

  const { accountSid, authToken } = config.identity.twilio;

  if (!accountSid || !authToken) {
    log.warn('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN required)');
    return null;
  }

  twilioClient = twilio(accountSid, authToken);
  log.info('Twilio client initialized');
  return twilioClient;
}

// ============================================================================
// SMS SENDING
// ============================================================================

/**
 * Send an SMS message via Twilio
 *
 * @param to Recipient phone number (E.164 format, e.g., '+15551234567')
 * @param body SMS message body
 * @returns Result with success status and Twilio message SID
 */
export async function sendSMS(
  to: string,
  body: string
): Promise<{ success: boolean; sid?: string; error?: string }> {
  const client = getClient();

  if (!client) {
    log.warn('Cannot send SMS - Twilio client not configured');
    return { success: false, error: 'Twilio client not configured' };
  }

  const fromPhone = process.env.TWILIO_FROM_PHONE;
  if (!fromPhone) {
    log.warn('Cannot send SMS - TWILIO_FROM_PHONE not configured');
    return { success: false, error: 'TWILIO_FROM_PHONE not configured' };
  }

  try {
    const message = await twilioBreaker.execute(() => client.messages.create({
      to,
      from: fromPhone,
      body,
    }));

    log.info({ to, sid: message.sid, status: message.status }, 'sms_sent');

    return { success: true, sid: message.sid };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    log.error({ err: errorMessage, to }, 'sms_send_error');

    return { success: false, error: errorMessage };
  }
}

// ============================================================================
// PHONE VERIFICATION (Twilio Verify)
// ============================================================================

/**
 * Send a verification code to a phone number via Twilio Verify
 *
 * @param to Phone number to verify (E.164 format)
 * @param channel Verification channel ('sms' or 'call')
 * @returns Result with success status and verification SID
 */
export async function sendVerification(
  to: string,
  channel: 'sms' | 'call' = 'sms'
): Promise<{ success: boolean; sid?: string; error?: string }> {
  const client = getClient();

  if (!client) {
    log.warn('Cannot send verification - Twilio client not configured');
    return { success: false, error: 'Twilio client not configured' };
  }

  const { verifyServiceSid } = config.identity.twilio;
  if (!verifyServiceSid) {
    log.warn('Cannot send verification - TWILIO_VERIFY_SERVICE_SID not configured');
    return { success: false, error: 'TWILIO_VERIFY_SERVICE_SID not configured' };
  }

  try {
    const verification = await twilioBreaker.execute(() => client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({
        to,
        channel,
      }));

    log.info({ to, channel, sid: verification.sid, status: verification.status }, 'verification_sent');

    return { success: true, sid: verification.sid };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    log.error({ err: errorMessage, to, channel }, 'verification_send_error');

    return { success: false, error: errorMessage };
  }
}

/**
 * Check a verification code against Twilio Verify
 *
 * @param to Phone number that was verified (E.164 format)
 * @param code Verification code entered by user
 * @returns Result with success status and whether code is valid
 */
export async function checkVerification(
  to: string,
  code: string
): Promise<{ success: boolean; valid: boolean; error?: string }> {
  const client = getClient();

  if (!client) {
    log.warn('Cannot check verification - Twilio client not configured');
    return { success: false, valid: false, error: 'Twilio client not configured' };
  }

  const { verifyServiceSid } = config.identity.twilio;
  if (!verifyServiceSid) {
    log.warn('Cannot check verification - TWILIO_VERIFY_SERVICE_SID not configured');
    return { success: false, valid: false, error: 'TWILIO_VERIFY_SERVICE_SID not configured' };
  }

  try {
    const verificationCheck = await twilioBreaker.execute(() => client.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({
        to,
        code,
      }));

    const isValid = verificationCheck.status === 'approved';

    log.info({ to, valid: isValid, status: verificationCheck.status }, 'verification_checked');

    return { success: true, valid: isValid };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    log.error({ err: errorMessage, to }, 'verification_check_error');

    return { success: false, valid: false, error: errorMessage };
  }
}
