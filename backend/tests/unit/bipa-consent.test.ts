/**
 * BIPA Biometric Consent Unit Tests
 *
 * Tests the biometric consent enforcement required by
 * Illinois Biometric Information Privacy Act (740 ILCS 14).
 *
 * @see backend/src/services/GDPRService.ts (hasBiometricConsent)
 * @see backend/src/routers/biometric.ts (consent checks)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => ''),
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base,
    escrowLogger: base,
    taskLogger: base,
    aiLogger: base,
    stripeLogger: base,
    authLogger: base,
    workerLogger: base,
    dbLogger: base,
  };
});

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  };
});

import { db } from '../../src/db';
import { GDPRService } from '../../src/services/GDPRService';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

// ============================================================================
// hasBiometricConsent
// ============================================================================

describe('GDPRService.hasBiometricConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when biometric_data consent is granted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ granted: true }],
    });

    const result = await GDPRService.hasBiometricConsent('user-123');
    expect(result).toBe(true);

    // Verify the correct query was made
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('biometric_data'),
      expect.arrayContaining(['user-123'])
    );
  });

  it('returns false when no consent record exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
    });

    const result = await GDPRService.hasBiometricConsent('user-456');
    expect(result).toBe(false);
  });

  it('returns false when consent is revoked (query filters by granted=true)', async () => {
    // SQL includes `AND granted = true`, so revoked consent returns empty rows
    mockQuery.mockResolvedValueOnce({
      rows: [],
    });

    const result = await GDPRService.hasBiometricConsent('user-789');
    expect(result).toBe(false);
  });

  it('fails closed (returns false) on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await GDPRService.hasBiometricConsent('user-error');
    expect(result).toBe(false);
  });

  it('queries for correct consent_type', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await GDPRService.hasBiometricConsent('user-check');

    // Ensure it specifically looks for 'biometric_data' consent type
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain('biometric_data');
    expect(queryCall[0]).toContain('granted');
  });
});

// ============================================================================
// ConsentType includes biometric_data
// ============================================================================

describe('BIPA consent type registration', () => {
  it('biometric_data is a valid consent type for updateConsent', async () => {
    // Setup: mock successful upsert
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'consent-1', consent_type: 'biometric_data', granted: true }],
    });

    const result = await GDPRService.updateConsent({
      userId: 'user-123',
      consentType: 'biometric_data',
      granted: true,
    });

    // Should not fail with invalid consent type
    expect(result.success).toBe(true);
  });
});
