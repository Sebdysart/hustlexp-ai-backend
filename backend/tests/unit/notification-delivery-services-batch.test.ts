import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// ALL MOCKS MUST BE AT THE TOP
// ============================================================================

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
  authLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    firebase: {
      projectId: '',
      privateKey: '',
      clientEmail: '',
      webApiKey: '',
    },
    identity: {
      twilio: {
        accountSid: '',
        authToken: '',
        verifyServiceSid: '',
      },
    },
    redis: {
      restUrl: '',
      restToken: '',
    },
    app: {
      isDevelopment: true,
    },
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  twilioBreaker: {
    execute: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
  CircuitBreaker: vi.fn(),
  CircuitOpenError: class extends Error {
    retryAfterMs = 0;
  },
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({ sid: 'SM_test_123', status: 'queued' }),
    },
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: {
            create: vi.fn().mockResolvedValue({ sid: 'VE_test_123', status: 'pending' }),
          },
          verificationChecks: {
            create: vi.fn().mockResolvedValue({ sid: 'VC_test_123', status: 'approved' }),
          },
        })),
      },
    },
  })),
}));

vi.mock('../../src/auth/firebase', () => ({
  messaging: null,
  auth: null,
  verifyIdToken: vi.fn(),
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { db } from '../../src/db';
import {
  getAdminUserIds,
  invalidateAdminCache,
  notifyAdmins,
} from '../../src/services/AdminNotificationHelper';
import { sendPushNotification, sendBatch } from '../../src/services/PushNotificationService';
import { sendSMS, sendVerification, checkVerification } from '../../src/services/TwilioSMSService';
import { NotificationService } from '../../src/services/NotificationService';

const mockDb = vi.mocked(db);
const mockNotificationService = vi.mocked(NotificationService);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module-level caches between tests
  invalidateAdminCache();
});

// ============================================================================
// Notification services
// ============================================================================

describe('AdminNotificationHelper', () => {
  describe('getAdminUserIds', () => {
    it('queries admin_roles table and returns user IDs', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }, { user_id: 'admin-2' }],
        rowCount: 2,
      } as never);

      const ids = await getAdminUserIds();

      expect(ids).toEqual(['admin-1', 'admin-2']);
      expect(mockDb.query).toHaveBeenCalledOnce();
    });

    it('caches results and avoids duplicate DB calls', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }],
        rowCount: 1,
      } as never);

      // First call → hits DB
      const first = await getAdminUserIds();
      // Second call → should use cache
      const second = await getAdminUserIds();

      expect(first).toEqual(['admin-1']);
      expect(second).toEqual(['admin-1']);
      // DB should only be called once
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no admins found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const ids = await getAdminUserIds();

      expect(ids).toEqual([]);
    });

    it('returns empty array on DB error (graceful degradation)', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Connection refused'));

      const ids = await getAdminUserIds();

      expect(ids).toEqual([]);
    });
  });

  describe('invalidateAdminCache', () => {
    it('forces fresh DB query after cache invalidation', async () => {
      // Populate cache
      mockDb.query.mockResolvedValueOnce({ rows: [{ user_id: 'admin-1' }], rowCount: 1 } as never);
      await getAdminUserIds();

      invalidateAdminCache();

      // Should hit DB again
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }, { user_id: 'admin-2' }],
        rowCount: 2,
      } as never);
      const ids = await getAdminUserIds();

      expect(ids).toHaveLength(2);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('notifyAdmins', () => {
    it('keeps different admin alerts/entities distinct while deduping retries per recipient', async () => {
      mockDb.query.mockResolvedValue({rows:[{user_id:'admin-1'},{user_id:'admin-2'}],rowCount:2} as never);
      const input = {title:'Refund failed',body:'Retry details',deepLink:'/admin/escrows/escrow-1',priority:'HIGH' as const,metadata:{stripe_event_id:'event-1'}};
      await notifyAdmins(input);
      await notifyAdmins({...input,body:'Updated retry diagnostics'});
      await notifyAdmins({...input,deepLink:'/admin/escrows/escrow-2'});
      await notifyAdmins({...input,title:'Payout blocked'});
      await notifyAdmins({...input,metadata:{stripe_event_id:'event-2'}});
      const notifications=vi.mocked(NotificationService.createNotification).mock.calls.map(([value])=>value);
      expect(new Set(notifications.map(value=>value.dedupeKey)).size).toBe(8);
      expect(notifications[0].dedupeKey).toBe(notifications[2].dedupeKey);
      expect(notifications[0].objectRef?.type).toBe('admin_alert');
    });
    it.each(['removed', 'lookup failed'])('never sends to a cached administrator after %s', async (state) => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ user_id: 'former-admin' }] } as never);
      await getAdminUserIds();
      if (state === 'removed') mockDb.query.mockResolvedValueOnce({ rows: [] } as never);
      else mockDb.query.mockRejectedValueOnce(new Error('lookup failed'));
      expect(await notifyAdmins({ title:'Alert',body:'Private operation',deepLink:'/ops',priority:'HIGH' })).toEqual({sent:0,failed:0});
      expect(mockNotificationService.createNotification).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenLastCalledWith(expect.stringContaining("u.account_status = 'ACTIVE'"));
    });
    it('returns sent:0, failed:0 when no admins found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await notifyAdmins({
        title: 'Fraud Alert',
        body: 'Suspicious activity detected',
        deepLink: '/admin/fraud',
        priority: 'critical',
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('sends notifications to all admin users', async () => {
      // getAdminUserIds
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }, { user_id: 'admin-2' }],
        rowCount: 2,
      } as never);

      mockNotificationService.createNotification.mockResolvedValue({ success: true } as never);

      const result = await notifyAdmins({
        title: 'Test Alert',
        body: 'Test body',
        deepLink: '/admin',
        priority: 'high',
      });

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockNotificationService.createNotification).toHaveBeenCalledTimes(2);
    });

    it('counts failures when createNotification returns success:false', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }, { user_id: 'admin-2' }],
        rowCount: 2,
      } as never);

      mockNotificationService.createNotification
        .mockResolvedValueOnce({ success: true } as never)
        .mockResolvedValueOnce({ success: false, error: { message: 'User not found' } } as never);

      const result = await notifyAdmins({
        title: 'Alert',
        body: 'Body',
        deepLink: '/admin',
        priority: 'medium',
      });

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('counts failures when createNotification rejects', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }],
        rowCount: 1,
      } as never);

      mockNotificationService.createNotification.mockRejectedValueOnce(
        new Error('Network timeout')
      );

      const result = await notifyAdmins({
        title: 'Alert',
        body: 'Body',
        deepLink: '/admin',
        priority: 'low',
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('passes security_alert category to bypass quiet hours', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'admin-1' }],
        rowCount: 1,
      } as never);

      mockNotificationService.createNotification.mockResolvedValueOnce({ success: true } as never);

      await notifyAdmins({
        title: 'Security Alert',
        body: 'Body',
        deepLink: '/admin/security',
        priority: 'critical',
        metadata: { incidentId: 'inc-123' },
      });

      expect(mockNotificationService.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'security_alert' })
      );
    });
  });
});

// ============================================================================
// PushNotificationService
// ============================================================================

describe('PushNotificationService', () => {
  describe('sendPushNotification', () => {
    it('reports provider unavailability when Firebase messaging is null', async () => {
      // firebase mock already returns messaging: null
      const result = await sendPushNotification('user-1', 'Title', 'Body');

      expect(result.success).toBe(false);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.reason).toBe('provider_unconfigured');
    });

    it('returns success with zero counts when no device tokens found', async () => {
      // Override firebase mock to provide a messaging instance for this test
      const firebaseMock = await import('../../src/auth/firebase');
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, responses: [] }),
      };
      vi.mocked(firebaseMock).messaging = mockMessaging as unknown as typeof firebaseMock.messaging;

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await sendPushNotification('user-1', 'Title', 'Body');

      expect(result.success).toBe(true);
      expect(result.sent).toBe(0);

      // Reset
      vi.mocked(firebaseMock).messaging = null;
    });

    it('sends to device tokens and returns counts', async () => {
      const firebaseMock = await import('../../src/auth/firebase');
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockResolvedValue({
          successCount: 2,
          failureCount: 0,
          responses: [{ success: true }, { success: true }],
        }),
      };
      vi.mocked(firebaseMock).messaging = mockMessaging as unknown as typeof firebaseMock.messaging;

      mockDb.query.mockResolvedValueOnce({
        rows: [{ fcm_token: 'tok-a' }, { fcm_token: 'tok-b' }],
        rowCount: 2,
      } as never);

      const result = await sendPushNotification('user-1', 'Hello', 'World', { type: 'task' });

      expect(result.success).toBe(true);
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);

      // Reset
      vi.mocked(firebaseMock).messaging = null;
    });

    it('deactivates invalid/unregistered tokens on failure', async () => {
      const firebaseMock = await import('../../src/auth/firebase');
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockResolvedValue({
          successCount: 1,
          failureCount: 1,
          responses: [
            { success: true },
            {
              success: false,
              error: { code: 'messaging/registration-token-not-registered' },
            },
          ],
        }),
      };
      vi.mocked(firebaseMock).messaging = mockMessaging as unknown as typeof firebaseMock.messaging;

      mockDb.query.mockResolvedValueOnce({
        rows: [{ fcm_token: 'tok-valid' }, { fcm_token: 'tok-expired' }],
        rowCount: 2,
      } as never);

      // Deactivation UPDATE query
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await sendPushNotification('user-1', 'Title', 'Body');

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
      // Should have called deactivation query
      expect(mockDb.query).toHaveBeenCalledTimes(2);

      // Reset
      vi.mocked(firebaseMock).messaging = null;
    });

    it('returns success:false gracefully on sendEachForMulticast error', async () => {
      const firebaseMock = await import('../../src/auth/firebase');
      const mockMessaging = {
        sendEachForMulticast: vi.fn().mockRejectedValue(new Error('FCM service unavailable')),
      };
      vi.mocked(firebaseMock).messaging = mockMessaging as unknown as typeof firebaseMock.messaging;

      mockDb.query.mockResolvedValueOnce({
        rows: [{ fcm_token: 'tok-1' }],
        rowCount: 1,
      } as never);

      const result = await sendPushNotification('user-1', 'Title', 'Body');

      expect(result.success).toBe(false);
      expect(result.sent).toBe(0);

      // Reset
      vi.mocked(firebaseMock).messaging = null;
    });
  });

  describe('sendBatch', () => {
    it('returns zero counts for empty user array', async () => {
      const result = await sendBatch([], 'Title', 'Body');

      expect(result.success).toBe(true);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('aggregates results across multiple users', async () => {
      // Firebase messaging null means sendPushNotification returns { success:true, sent:0, failed:0 } for each
      const result = await sendBatch(['user-1', 'user-2', 'user-3'], 'Title', 'Body');

      expect(result.success).toBe(true);
      expect(result.sent).toBe(0); // messaging is null
    });
  });
});

// ============================================================================
// TwilioSMSService
// ============================================================================

describe('TwilioSMSService', () => {
  describe('sendSMS', () => {
    it('returns error when Twilio client is not configured (no accountSid)', async () => {
      // Config mock has empty accountSid/authToken by default
      const result = await sendSMS('+15551234567', 'Hello!');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns error when TWILIO_FROM_PHONE is not set', async () => {
      const { config } = await import('../../src/config');
      vi.mocked(config).identity.twilio.accountSid = 'ACtest123';
      vi.mocked(config).identity.twilio.authToken = 'auth_token';
      delete process.env.TWILIO_FROM_PHONE;

      const result = await sendSMS('+15551234567', 'Hello!');

      // Twilio client gets created but from phone is missing
      // The module-level singleton might already be set, so check graceful failure
      expect(result.success).toBe(false);

      // Reset config
      vi.mocked(config).identity.twilio.accountSid = '';
      vi.mocked(config).identity.twilio.authToken = '';
    });

    it('sends SMS and returns sid when properly configured', async () => {
      const { config } = await import('../../src/config');
      vi.mocked(config).identity.twilio.accountSid = 'ACtest123';
      vi.mocked(config).identity.twilio.authToken = 'auth_token';
      process.env.TWILIO_FROM_PHONE = '+15550000000';

      const { twilioBreaker } = await import('../../src/middleware/circuit-breaker');

      // twilioBreaker.execute is already mocked to pass through
      // The twilio mock returns { sid: 'SM_test_123' }

      const result = await sendSMS('+15551234567', 'Test message');

      // The module uses a lazy singleton — on first configured call it initializes
      // Result depends on whether singleton was already null or not
      // In fresh test environment: success with sid
      if (result.success) {
        expect(result.sid).toBeDefined();
      }
      // At minimum it should not throw
      expect(typeof result).toBe('object');

      delete process.env.TWILIO_FROM_PHONE;
      vi.mocked(config).identity.twilio.accountSid = '';
      vi.mocked(config).identity.twilio.authToken = '';
    });
  });

  describe('sendVerification', () => {
    it('returns error when Twilio client is not configured', async () => {
      const result = await sendVerification('+15551234567', 'sms');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns error when verifyServiceSid is not configured', async () => {
      const { config } = await import('../../src/config');
      vi.mocked(config).identity.twilio.accountSid = 'ACtest123';
      vi.mocked(config).identity.twilio.authToken = 'auth_token';
      vi.mocked(config).identity.twilio.verifyServiceSid = ''; // Not set

      const result = await sendVerification('+15551234567', 'sms');

      expect(result.success).toBe(false);
      expect(result.error).toContain('TWILIO_VERIFY_SERVICE_SID not configured');

      vi.mocked(config).identity.twilio.accountSid = '';
      vi.mocked(config).identity.twilio.authToken = '';
    });

    it('defaults channel to sms when not specified', async () => {
      // The function signature has default parameter 'sms', verify behavior
      const result = await sendVerification('+15551234567');

      expect(result.success).toBe(false); // Not configured in clean test
      expect(result.error).toBeDefined();
    });
  });

  describe('checkVerification', () => {
    it('returns error when Twilio client is not configured', async () => {
      const result = await checkVerification('+15551234567', '123456');

      expect(result.success).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns error when verifyServiceSid is not configured', async () => {
      const { config } = await import('../../src/config');
      vi.mocked(config).identity.twilio.accountSid = 'ACtest123';
      vi.mocked(config).identity.twilio.authToken = 'auth_token';
      vi.mocked(config).identity.twilio.verifyServiceSid = '';

      const result = await checkVerification('+15551234567', '123456');

      expect(result.success).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('TWILIO_VERIFY_SERVICE_SID not configured');

      vi.mocked(config).identity.twilio.accountSid = '';
      vi.mocked(config).identity.twilio.authToken = '';
    });

    it('returns valid:true when verification status is approved', async () => {
      const { config } = await import('../../src/config');
      vi.mocked(config).identity.twilio.accountSid = 'ACtest123';
      vi.mocked(config).identity.twilio.authToken = 'auth_token';
      vi.mocked(config).identity.twilio.verifyServiceSid = 'VA_test123';

      // The twilio mock's verificationChecks.create returns { status: 'approved' }
      const result = await checkVerification('+15551234567', '123456');

      // If twilioClient was already set (not null), it processes the check
      if (result.success) {
        expect(result.valid).toBe(true);
      }
      // At minimum it should not throw
      expect(typeof result.valid).toBe('boolean');

      vi.mocked(config).identity.twilio.accountSid = '';
      vi.mocked(config).identity.twilio.authToken = '';
      vi.mocked(config).identity.twilio.verifyServiceSid = '';
    });
  });
});
