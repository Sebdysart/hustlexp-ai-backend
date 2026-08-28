import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

import { scrubPII, scrubObjectPII, logScrubSummary } from '../../src/lib/pii-scrubber';

describe('PII Scrubber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Email scrubbing
  // ===========================================================================
  describe('emails', () => {
    it('redacts email addresses', () => {
      expect(scrubPII('Contact me at john@example.com')).toContain('[EMAIL_REDACTED]');
    });

    it('handles multiple emails', () => {
      const result = scrubPII('From a@b.com to c@d.com');
      const count = (result.match(/\[EMAIL_REDACTED\]/g) || []).length;
      expect(count).toBe(2);
    });

    it('can be disabled', () => {
      const result = scrubPII('john@example.com', { emails: false });
      expect(result).toContain('john@example.com');
    });
  });

  // ===========================================================================
  // Phone scrubbing
  // ===========================================================================
  describe('phones', () => {
    it('redacts US phone numbers', () => {
      expect(scrubPII('Call 555-123-4567')).toContain('[PHONE_REDACTED]');
    });

    it('redacts phone with area code parens', () => {
      expect(scrubPII('Call (555) 123-4567')).toContain('[PHONE_REDACTED]');
    });

    it('redacts phone with country code', () => {
      expect(scrubPII('Call +1 555-123-4567')).toContain('[PHONE_REDACTED]');
    });

    it('can be disabled', () => {
      const result = scrubPII('Call 555-123-4567', { phones: false });
      expect(result).not.toContain('[PHONE_REDACTED]');
    });
  });

  // ===========================================================================
  // SSN scrubbing
  // ===========================================================================
  describe('SSNs', () => {
    it('redacts valid SSN patterns', () => {
      expect(scrubPII('SSN: 123-45-6789')).toContain('[SSN_REDACTED]');
    });

    it('skips invalid SSN area numbers (000, 666, 900+)', () => {
      expect(scrubPII('Number 000-12-3456')).not.toContain('[SSN_REDACTED]');
      expect(scrubPII('Number 666-12-3456')).not.toContain('[SSN_REDACTED]');
      expect(scrubPII('Number 900-12-3456')).not.toContain('[SSN_REDACTED]');
    });

    it('can be disabled', () => {
      const result = scrubPII('SSN: 123-45-6789', { ssns: false });
      expect(result).not.toContain('[SSN_REDACTED]');
    });
  });

  // ===========================================================================
  // Credit card scrubbing
  // ===========================================================================
  describe('credit cards', () => {
    it('redacts Luhn-valid credit card numbers', () => {
      // 4111111111111111 is a standard Visa test number (passes Luhn)
      expect(scrubPII('Card: 4111111111111111')).toContain('[CC_REDACTED]');
    });

    it('skips numbers that fail Luhn check', () => {
      expect(scrubPII('Number: 1234567890123456')).not.toContain('[CC_REDACTED]');
    });

    it('can be disabled', () => {
      const result = scrubPII('Card: 4111111111111111', { creditCards: false });
      expect(result).not.toContain('[CC_REDACTED]');
    });
  });

  // ===========================================================================
  // GPS scrubbing
  // ===========================================================================
  describe('GPS coordinates', () => {
    it('generalises GPS to neighbourhood level', () => {
      const result = scrubPII('Location: (37.7749, -122.4194)');
      expect(result).toContain('37.77');
      expect(result).toContain('-122.42');
      // Should NOT contain full precision
      expect(result).not.toContain('37.7749');
    });

    it('can be disabled', () => {
      const result = scrubPII('Location: (37.7749, -122.4194)', { gps: false });
      expect(result).toContain('37.7749');
    });
  });

  // ===========================================================================
  // User ID scrubbing
  // ===========================================================================
  describe('user IDs', () => {
    it('anonymises user ID tokens', () => {
      const result = scrubPII('User user_abc123 posted');
      expect(result).toContain('[USER_');
    });

    it('maps same ID to same anonymous token', () => {
      const result = scrubPII('user_abc123 and user_abc123');
      const matches = result.match(/\[USER_\d+\]/g);
      expect(matches).toBeDefined();
      expect(matches![0]).toBe(matches![1]);
    });

    it('maps different IDs to different tokens', () => {
      const result = scrubPII('user_abc123 and user_def456');
      const matches = result.match(/\[USER_\d+\]/g);
      expect(matches).toBeDefined();
      expect(matches!.length).toBe(2);
      expect(matches![0]).not.toBe(matches![1]);
    });

    it('can be disabled', () => {
      const result = scrubPII('User user_abc123', { userIds: false });
      expect(result).not.toContain('[USER_');
    });
  });

  // ===========================================================================
  // Name scrubbing
  // ===========================================================================
  describe('names', () => {
    it('redacts likely personal names', () => {
      const result = scrubPII('Assigned to John Smith for the task');
      expect(result).toContain('[NAME_REDACTED]');
    });

    it('preserves known false positives (cities, etc)', () => {
      const result = scrubPII('Located in New York');
      expect(result).toContain('New York');
      expect(result).not.toContain('[NAME_REDACTED]');
    });

    it('can be disabled', () => {
      const result = scrubPII('John Smith', { names: false });
      expect(result).not.toContain('[NAME_REDACTED]');
    });
  });

  // ===========================================================================
  // scrubObjectPII
  // ===========================================================================
  describe('scrubObjectPII', () => {
    it('scrubs strings in objects', () => {
      const result = scrubObjectPII({ email: 'john@example.com', count: 42 });
      expect(result.email).toContain('[EMAIL_REDACTED]');
      expect(result.count).toBe(42);
    });

    it('scrubs nested objects', () => {
      const result = scrubObjectPII({
        user: { email: 'a@b.com', profile: { phone: '555-123-4567' } },
      });
      expect(result.user.email).toContain('[EMAIL_REDACTED]');
      expect(result.user.profile.phone).toContain('[PHONE_REDACTED]');
    });

    it('scrubs arrays', () => {
      const result = scrubObjectPII(['john@test.com', 'jane@test.com']);
      expect(result[0]).toContain('[EMAIL_REDACTED]');
      expect(result[1]).toContain('[EMAIL_REDACTED]');
    });

    it('handles null and undefined', () => {
      expect(scrubObjectPII(null)).toBeNull();
      expect(scrubObjectPII(undefined)).toBeUndefined();
    });

    it('preserves Date objects', () => {
      const date = new Date('2026-01-01');
      expect(scrubObjectPII(date)).toBe(date);
    });

    it('preserves non-string primitives', () => {
      expect(scrubObjectPII(42)).toBe(42);
      expect(scrubObjectPII(true)).toBe(true);
    });
  });

  // ===========================================================================
  // logScrubSummary
  // ===========================================================================
  describe('logScrubSummary', () => {
    it('does not throw when no redactions', () => {
      expect(() => logScrubSummary('hello', 'hello')).not.toThrow();
    });

    it('does not throw when redactions exist', () => {
      expect(() => logScrubSummary(
        'john@test.com',
        '[EMAIL_REDACTED]',
      )).not.toThrow();
    });
  });
});
