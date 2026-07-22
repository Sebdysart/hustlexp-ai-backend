import { describe, expect, it } from 'vitest';

import {
  applyNotificationPresentation,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CLASSES,
  NOTIFICATION_POLICY,
  nextQuietHoursEnd,
  resolveNotificationChannels,
  validateNotificationDeepLink,
} from '../../src/services/NotificationPolicy.js';

describe('HX/OS notification architecture policy', () => {
  it('classifies every notification category into exactly one required class', () => {
    expect(NOTIFICATION_CLASSES).toEqual([
      'transaction_critical',
      'action_required',
      'status',
      'operational_digest',
      'growth',
    ]);
    expect(Object.keys(NOTIFICATION_POLICY).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());

    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_CLASSES).toContain(NOTIFICATION_POLICY[category].notificationClass);
    }
  });

  it('requires every class to expose the complete delivery and recovery contract', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const policy = NOTIFICATION_POLICY[category];
      expect(policy.objectReferenceRequired).toBe(true);
      expect(policy.deepLinkRequired).toBe(true);
      expect(policy.dedupeRequired).toBe(true);
      expect(policy.maxDeliveryAttempts).toBeGreaterThan(0);
      expect(policy.maxDeliveryAttempts).toBeLessThanOrEqual(5);
      expect(policy.providerStatusRequired).toBe(true);
      expect(policy.terminalFailureVisibility).toBe('operator_exception');
      expect(policy.allowedChannels.length).toBeGreaterThan(0);
      expect(policy.defaultChannels.length).toBeGreaterThan(0);
      expect(policy.defaultChannels.every((channel) => policy.allowedChannels.includes(channel))).toBe(true);
      expect(policy.allowedChannels.every((channel) => NOTIFICATION_CHANNELS.includes(channel))).toBe(true);
      expect(['respect', 'active_task_override', 'security_override']).toContain(policy.quietHours);
      expect(['transactional', 'explicit_opt_in']).toContain(policy.consent);
      expect(['allow', 'defer_during_active_execution']).toContain(policy.focusSuppression);
      expect(['transactional', 'operational', 'optional_growth']).toContain(policy.contentIdentity);
    }
  });

  it('defers only P3-P5 opportunity, digest, and growth traffic during active execution', () => {
    const deferred = NOTIFICATION_CATEGORIES.filter(
      (category) => NOTIFICATION_POLICY[category].focusSuppression === 'defer_during_active_execution',
    );
    expect(deferred.sort()).toEqual([
      'badge_earned',
      'business_operational_digest',
      'growth_rebook',
      'instant_task_available',
      'live_mode_task',
      'maintenance_suggestion',
      'new_matching_task',
      'provider_reactivation',
      'trust_tier_upgraded',
      'unread_messages',
      'weekly_recap',
      'welcome',
    ].sort());
    for (const material of [
      'provider_arrived', 'scope_change_required', 'payment_failed', 'payment_released',
      'dispute_opened', 'message_received',
    ] as const) {
      expect(NOTIFICATION_POLICY[material].focusSuppression).toBe('allow');
    }
  });

  it('forces provider-visible optional identity onto growth copy and system-owned metadata', () => {
    expect(applyNotificationPresentation(
      NOTIFICATION_POLICY.maintenance_suggestion,
      '  Schedule maintenance  ',
      { notificationIntent: 'transactional', source: 'maintenance' },
    )).toEqual({
      title: 'Optional · Schedule maintenance',
      metadata: { notificationIntent: 'optional_growth', source: 'maintenance' },
    });
    expect(applyNotificationPresentation(
      NOTIFICATION_POLICY.payment_failed,
      'Payment failed',
    )).toEqual({
      title: 'Payment failed',
      metadata: { notificationIntent: 'transactional' },
    });
  });

  it('never lets growth masquerade as transactional or bypass quiet hours', () => {
    const growth = NOTIFICATION_CATEGORIES.filter(
      (category) => NOTIFICATION_POLICY[category].notificationClass === 'growth',
    );
    expect(growth.length).toBeGreaterThan(0);
    for (const category of growth) {
      expect(NOTIFICATION_POLICY[category]).toMatchObject({
        consent: 'explicit_opt_in',
        quietHours: 'respect',
        allowedChannels: ['push', 'email'],
      });
    }
  });

  it('enforces the supplied class channel contract and class-owned defaults', () => {
    expect(resolveNotificationChannels(NOTIFICATION_POLICY.task_completed)).toEqual({
      valid: true,
      channels: ['in_app', 'push'],
    });
    expect(resolveNotificationChannels(
      NOTIFICATION_POLICY.business_operational_digest,
      ['in_app', 'email'],
    )).toEqual({ valid: true, channels: ['in_app', 'email'] });
    expect(resolveNotificationChannels(
      NOTIFICATION_POLICY.business_operational_digest,
      ['push'],
    )).toEqual({ valid: false, reason: 'notification_channel_forbidden' });
    expect(resolveNotificationChannels(
      NOTIFICATION_POLICY.growth_rebook,
      ['sms'],
    )).toEqual({ valid: false, reason: 'notification_channel_forbidden' });
  });

  it('summarizes operational activity instead of permitting event-by-event digest spam', () => {
    expect(NOTIFICATION_POLICY.weekly_recap).toMatchObject({
      notificationClass: 'operational_digest',
      aggregationRequired: true,
      quietHours: 'respect',
    });
  });

  it('defines deterministic cancellation for superseded task and dispute states', () => {
    expect(NOTIFICATION_POLICY.task_cancelled.supersedes).toEqual(expect.arrayContaining([
      'new_matching_task', 'instant_task_available', 'task_accepted', 'proof_submitted',
    ]));
    expect(NOTIFICATION_POLICY.task_completed.supersedes).toEqual(expect.arrayContaining([
      'task_accepted', 'proof_submitted', 'proof_rejected',
    ]));
    expect(NOTIFICATION_POLICY.dispute_resolved.supersedes).toContain('dispute_opened');
    expect(NOTIFICATION_POLICY.payment_released.supersedes).toContain('payment_due');
  });

  it.each([
    '/tasks/task-1',
    'hustlexp://tasks/task-1',
    'app://settings/payments',
  ])('accepts an internal deep link: %s', (deepLink) => {
    expect(validateNotificationDeepLink(deepLink)).toEqual({ valid: true });
  });

  it.each([
    '',
    '   ',
    'javascript:alert(1)',
    'https://evil.example/phish',
    '//evil.example/phish',
    'tasks/task-1',
  ])('rejects an absent or external deep link: %s', (deepLink) => {
    expect(validateNotificationDeepLink(deepLink).valid).toBe(false);
  });

  it('defers overnight quiet-hour delivery until the configured end', () => {
    const duringQuiet = new Date('2026-07-21T06:30:00.000Z');
    const end = nextQuietHoursEnd(
      duringQuiet,
      '22:00:00',
      '07:00:00',
      'America/Los_Angeles',
    );
    expect(end?.toISOString()).toBe('2026-07-21T14:00:00.000Z');
  });

  it('returns null when delivery is outside quiet hours', () => {
    expect(nextQuietHoursEnd(
      new Date('2026-07-21T20:00:00.000Z'),
      '22:00:00',
      '07:00:00',
      'America/Los_Angeles',
    )).toBeNull();
  });
});
