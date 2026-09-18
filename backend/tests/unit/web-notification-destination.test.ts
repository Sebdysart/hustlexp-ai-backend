import { describe, it, expect } from 'vitest';
import { webNotificationDestination, notificationTaskId } from '../../src/services/WebNotificationDestination.js';

const id = '10000000-0000-4000-8000-000000000001';
describe('web notification destinations', () => {
  it.each(['', '/proof', '/applicants', '/accept'])('maps old task route %s using actual participation', (suffix) => {
    const link = `/tasks/${id}${suffix}`;
    expect(notificationTaskId(link)).toBe(id);
    expect(webNotificationDestination(link, 'poster')).toBe(`/dashboard/tasks/${id}`);
    expect(webNotificationDestination(link, 'provider')).toBe(`/business/tasks/${id}`);
    expect(webNotificationDestination(link)).toBeNull();
  });
  it('maps native messaging to the existing task detail', () => {
    expect(webNotificationDestination(`app://task/${id}/messages`, 'poster')).toBe(`/dashboard/tasks/${id}`);
  });
  it.each([
    ['/earnings', '/support'], [`app://wallet/${id}`, '/support'],
    ['app://settings/payouts', '/support'], ['app://settings/payments', '/support'], ['app://settings/xp-tax', '/support'],
    [`/admin/escrows/${id}`, '/ops/tasks'], [`hustlexp://admin/escrows/${id}`, '/ops/tasks'], [`/admin/stripe-events/${id}`, '/ops/tasks'],
    [`/business/${id}/operations?week=2026-09-14`, '/business/dashboard'], ['app://support', '/support'],
  ])('projects %s to %s without changing stored/native contracts', (input, expected) => {
    expect(webNotificationDestination(input)).toBe(expected);
  });
  it.each([
    `/dashboard/drafts/${id}`, `/dashboard/tasks/${id}`, `/dashboard/drafts/${id}/quote`,
    `/business/tasks/${id}`, `/business/claims/${id}`, `/business/proposals/${id}`,
    `/ops/drafts/${id}`, `/ops/tasks/${id}`, `/ops/support/${id}`, `/support/${id}`,
  ])('preserves current detail destination %s', (input) => expect(webNotificationDestination(input)).toBe(input));
  it.each([
    'https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil', '/settings?redirect=https://evil.test',
    `/claim/${id}`, '/made-up', `/dashboard/tasks/${id}/quote`,
    `app://admin/proof-review/${id}`, 'app://admin/email-outbox', `app://admin/moderation/${id}`,
    `app://content/${id}`, `app://moderation/${id}`, 'app://profile', 'app://admin/fraud', `app://expertise/invite/${id}`,
  ])('omits unsupported or unsafe web destinations: %s', (input) => expect(webNotificationDestination(input)).toBeNull());
});
