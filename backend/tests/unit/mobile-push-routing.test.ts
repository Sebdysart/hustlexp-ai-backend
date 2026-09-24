import { describe, expect, it } from 'vitest';
import { mobileVariantsForDestination } from '../../src/services/MobilePushRouting.js';

describe('mobile push destination ownership', () => {
  it('delivers poster work only to HustleXP', () => {
    expect(mobileVariantsForDestination('/dashboard')).toEqual(['poster']);
    expect(mobileVariantsForDestination('/dashboard/drafts/11111111-1111-4111-8111-111111111111/quote')).toEqual(['poster']);
    expect(mobileVariantsForDestination('/dashboard/tasks/11111111-1111-4111-8111-111111111111')).toEqual(['poster']);
    expect(mobileVariantsForDestination('/provider-os/invite/valid-token')).toEqual([]);
  });
  it('delivers business work only to HustleXP Business', () => {
    expect(mobileVariantsForDestination('/business/tasks/11111111-1111-4111-8111-111111111111')).toEqual(['business']);
    expect(mobileVariantsForDestination('/provider-os/quotes/11111111-1111-4111-8111-111111111111?organizationId=11111111-1111-4111-8111-111111111111')).toEqual(['business']);
  });
  it('shares account support but skips operations and arbitrary destinations', () => {
    expect(mobileVariantsForDestination('/support/11111111-1111-4111-8111-111111111111')).toEqual(['poster', 'business']);
    expect(mobileVariantsForDestination('/ops/support/11111111-1111-4111-8111-111111111111')).toEqual([]);
    expect(mobileVariantsForDestination('https://example.com')).toEqual([]);
    expect(mobileVariantsForDestination('//example.com')).toEqual([]);
  });
});
