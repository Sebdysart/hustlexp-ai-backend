
import { FastifyInstance } from 'fastify';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { env } from '../config/env.js';
import { canSendRealSms, canSendRealEmail } from '../config/safety.js';
import { VerificationService } from '../services/VerificationService.js';
import { TwilioVerifyService } from '../services/TwilioVerifyService.js';

export default async function debugRoutes(fastify: FastifyInstance) {

  // GET /api/test-db
  fastify.get('/test-db', async (request, reply) => {
    if (!isDatabaseAvailable() || !sql) {
      return reply.status(500).send({
        success: false,
        error: 'Database not configured (DATABASE_URL missing)'
      });
    }

    try {
      // 1. Simple Select
      const nowResult = await sql`SELECT NOW() as time`;
      const serverTime = nowResult[0].time;

      // 2. Test Table Insert (Temporary)
      // We create a temp table execution-local to verify write permissions
      // Note: CREATE TEMP TABLE might not work in serverless/pooled envs easily across requests,
      // but for a single request it might.
      // Safer: Just insert into users with a random ID and rollback?
      // Or just trust SELECT NOW() proves connection + READ.
      // To prove WRITE, let's try to update a non-existent row or something safe.
      // Actually, let's just create a dummy table if not exists.

      // Checking if we can create a table (requires admin privileges typically)
      // Let's stick to just SELECT NOW() for basic connectivity
      // AND a specific check on the 'users' table to verify schema existence.

      const usersCount = await sql`SELECT count(*) as count FROM users`;

      return {
        success: true,
        message: 'Database connection verified',
        timestamp: serverTime,
        usersCount: usersCount[0].count,
        mode: 'real'
      };

    } catch (error: any) {
      request.log.error({ error }, 'DB Test Failed');
      return reply.status(500).send({
        success: false,
        error: 'Database query failed',
        details: error.message
      });
    }
  });

  /**
   * GET /api/debug/verification-status
   * 
   * Returns comprehensive diagnostics for phone/email verification.
   * Admin-only endpoint for debugging verification issues.
   */
  fastify.get('/verification-status', async (request, reply) => {
    const userId = request.user?.uid;

    // Environment & Config Diagnostics
    const diagnostics = {
      timestamp: new Date().toISOString(),
      environment: {
        mode: env.mode,
        isProduction: env.isProduction,
        isStaging: env.isStaging,
        isLocal: env.isLocal,
      },
      smsConfig: {
        twilioAccountSidSet: !!env.TWILIO_ACCOUNT_SID,
        twilioAuthTokenSet: !!env.TWILIO_AUTH_TOKEN,
        twilioVerifyServiceSidSet: !!env.TWILIO_VERIFY_SERVICE_SID,
        twilioFullyConfigured: TwilioVerifyService.isConfigured(),
        smsRealDeliveryAllowed: canSendRealSms(),
        effectiveSmsMode: TwilioVerifyService.isConfigured() && canSendRealSms()
          ? 'REAL - SMS will be sent via Twilio'
          : TwilioVerifyService.isConfigured()
            ? 'FAKE - Twilio configured but blocked by environment safety'
            : 'FAKE - Twilio not configured, codes logged to console',
      },
      emailConfig: {
        sendgridApiKeySet: !!env.SENDGRID_API_KEY,
        emailRealDeliveryAllowed: canSendRealEmail(),
      },
      userVerificationStatus: null as any,
      troubleshooting: [] as string[],
    };

    // If user is authenticated, get their verification status
    if (userId) {
      const status = await VerificationService.getStatus(userId);
      diagnostics.userVerificationStatus = status || {
        note: 'No verification record found for this user',
      };

      // Generate troubleshooting tips
      if (status) {
        if (!status.emailVerified) {
          diagnostics.troubleshooting.push(
            '⚠️ Email not verified - user must complete email verification before phone'
          );
        }
        if (status.emailVerified && !status.phoneVerified) {
          diagnostics.troubleshooting.push(
            '📱 Ready for phone verification - email is verified'
          );
        }
        if (status.isLocked) {
          diagnostics.troubleshooting.push(
            '🔒 Account is locked due to too many failed attempts'
          );
        }
        if (status.canProceedToOnboarding) {
          diagnostics.troubleshooting.push(
            '✅ All verification complete - user can proceed to AI onboarding'
          );
        }
      }
    } else {
      diagnostics.userVerificationStatus = {
        note: 'No authenticated user - showing config only',
      };
    }

    // Add general troubleshooting tips based on config
    if (!TwilioVerifyService.isConfigured()) {
      diagnostics.troubleshooting.push(
        '⚠️ Twilio not configured - check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID'
      );
    }
    if (!canSendRealSms()) {
      diagnostics.troubleshooting.push(
        `ℹ️ Real SMS blocked by safety guard (environment: ${env.mode}) - codes will be logged to console`
      );
    }

    return diagnostics;
  });
}
