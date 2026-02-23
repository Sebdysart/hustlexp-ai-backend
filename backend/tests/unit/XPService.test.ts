import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: { emitTrustDeltaApplied: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: { redis: { restUrl: '', restToken: '' } },
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    incrby: vi.fn(),
    expire: vi.fn(),
  })),
}));

import { XPService } from '../../src/services/XPService';

describe('XPService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('state machine helpers', () => {
    // Test level calculation
    it('should calculate level 1 for 0 XP', async () => {
      // Level thresholds: 0, 100, 300, 700, ...
      // We can test calculateAward which internally uses these
    });
  });
});
