import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../../src/db.js', () => ({ db: {} }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: {} }));
import { PREMIUM_EVENTS, premiumMessage, premiumDestination, recipientSmsPolicy, type PremiumEvent, type PremiumRecipient } from '../../src/services/ProviderOsPremiumEvents.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { webNotificationDestination } from '../../src/services/WebNotificationDestination.js';

const id = '12345678-1234-4234-8234-123456789012';
const event: PremiumEvent = { id, event_type: 'CLIENT_JOINED', organization_id: id, poster_user_id: id, relationship_id: id, draft_id: id, quote_id: id, task_id: id, status: 'pending' };
const recipient: PremiumRecipient = { id, phone: '+15551234567', account_status: 'ACTIVE', is_banned: false, trust_hold: false, authorized: true, sms_enabled: true, quiet_hours_enabled: false, quiet_hours_start: null, quiet_hours_end: null, timezone: null };
describe('premium SMS policy', () => {
  it('supports exactly the four approved meanings and valid explicit-org destinations', () => {
    expect(PREMIUM_EVENTS).toEqual(['CLIENT_JOINED', 'CLIENT_TASK_POSTED', 'QUOTE_ACCEPTED', 'TASK_READY']);
    for (const type of PREMIUM_EVENTS) {
      const url = premiumDestination({ ...event, event_type: type });
      expect(webNotificationDestination(url)).toBe(url);
      expect(premiumMessage(type)).not.toContain(id);
      expect(url).not.toContain('/claims/');
    }
    expect(premiumMessage('QUOTE_ACCEPTED')).toContain('accepted your Provider OS quote');
    expect(premiumMessage('QUOTE_ACCEPTED').toLowerCase()).not.toContain('payment');
    expect(premiumMessage('TASK_READY')).toContain('payment is confirmed');
  });
  it.each([
    [{ authorized: false }, 'membership_ineligible'],
    [{ account_status: 'DEACTIVATED' }, 'account_ineligible'],
    [{ is_banned: true }, 'account_ineligible'],
    [{ trust_hold: true }, 'account_ineligible'],
    [{ sms_enabled: false }, 'sms_not_enabled'],
    [{ sms_enabled: null }, 'sms_not_enabled'],
    [{ phone: null }, 'phone_unusable'],
    [{ phone: '5551234567' }, 'phone_unusable'],
  ])('fails closed for %j', (patch, reason) => {
    expect(recipientSmsPolicy({ ...recipient, ...patch })).toEqual({ reason });
  });
  it('honors quiet hours and fails closed for invalid settings', () => {
    const now = new Date('2026-09-19T23:00:00Z');
    expect(recipientSmsPolicy({ ...recipient, quiet_hours_enabled: true, timezone: 'UTC' }, now).availableAt?.toISOString()).toBe('2026-09-20T07:00:00.000Z');
    expect(recipientSmsPolicy({ ...recipient, quiet_hours_enabled: true, timezone: 'invalid' }, now).reason).toBe('quiet_hours_invalid');
  });
  it('registers a new migration after ownership and quote provenance', () => {
    const names = REQUIRED_MIGRATION_FILES.map(m => m.name);
    expect(names.indexOf('20260920_provider_os_premium_events')).toBeGreaterThan(names.indexOf('20260919_provider_os_quote_origin'));
    const sql = readFileSync('backend/database/migrations/20260920_provider_os_premium_events.sql', 'utf8');
    expect(sql).toContain('AFTER INSERT ON provider_os_relationships');
    expect(sql).toContain('AFTER INSERT ON task_drafts');
    expect(sql).toContain('AFTER UPDATE OF quote_id ON task_drafts');
    expect(sql).toContain('AFTER INSERT OR UPDATE OF status ON quote_payments');
    expect(sql).not.toContain('INSERT INTO provider_os_notification_events');
  });
});
