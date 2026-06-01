/**
 * Fraud Guard Unit Tests (B#5)
 *
 * Tests the reusable fraudGuard middleware:
 * - HIGH/CRITICAL → always blocks
 * - MEDIUM + blockOnMedium → blocks (payout/release)
 * - MEDIUM default → allows + logs
 * - LOW → passes silently
 * - Service error + failClosed → blocks (payout)
 * - Service error + fail-open → allows (signup/post/etc.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/FraudDetectionService', () => ({
  FraudDetectionService: {
    getRiskAssessment: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { fraudGuard } from '../../src/middleware/fraud-guard';
import { FraudDetectionService } from '../../src/services/FraudDetectionService';

const mockGetRisk = vi.mocked(FraudDetectionService.getRiskAssessment);

beforeEach(() => vi.clearAllMocks());

const base = { entityType: 'user' as const, entityId: 'u-1', action: 'test' };

describe('fraudGuard', () => {
  it('blocks on HIGH risk', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.8, riskLevel: 'HIGH', recommendation: 'manual_review', flags: ['suspicious'], componentScores: {} } } as never);
    await expect(fraudGuard(base)).rejects.toThrow('Action blocked due to risk assessment');
  });

  it('blocks on CRITICAL risk', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.95, riskLevel: 'CRITICAL', recommendation: 'suspend', flags: [], componentScores: {} } } as never);
    await expect(fraudGuard(base)).rejects.toThrow('Action blocked');
  });

  it('blocks on auto_reject recommendation even at medium score', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.5, riskLevel: 'MEDIUM', recommendation: 'auto_reject', flags: [], componentScores: {} } } as never);
    await expect(fraudGuard(base)).rejects.toThrow('Action blocked');
  });

  it('allows MEDIUM risk by default (logs warning)', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.45, riskLevel: 'MEDIUM', recommendation: 'review', flags: ['velocity'], componentScores: {} } } as never);
    await expect(fraudGuard(base)).resolves.toBeUndefined();
  });

  it('blocks MEDIUM risk when blockOnMedium is true (payout)', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.45, riskLevel: 'MEDIUM', recommendation: 'review', flags: [], componentScores: {} } } as never);
    await expect(fraudGuard({ ...base, action: 'payout', blockOnMedium: true })).rejects.toThrow('Action blocked');
  });

  it('passes LOW risk silently', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: true, data: { riskScore: 0.1, riskLevel: 'LOW', recommendation: 'auto_approve', flags: [], componentScores: {} } } as never);
    await expect(fraudGuard(base)).resolves.toBeUndefined();
  });

  it('fails OPEN when fraud service errors and failClosed=false (signup)', async () => {
    mockGetRisk.mockRejectedValueOnce(new Error('DB down'));
    await expect(fraudGuard({ ...base, action: 'signup' })).resolves.toBeUndefined();
  });

  it('fails CLOSED when fraud service errors and failClosed=true (payout)', async () => {
    mockGetRisk.mockRejectedValueOnce(new Error('DB down'));
    await expect(fraudGuard({ ...base, action: 'payout', failClosed: true })).rejects.toThrow('Risk assessment unavailable');
  });

  it('fails CLOSED when getRiskAssessment returns { success: false } and failClosed=true', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: false, error: { code: 'DB_ERR', message: 'timeout' } } as never);
    await expect(fraudGuard({ ...base, failClosed: true })).rejects.toThrow('Risk assessment unavailable');
  });

  it('fails OPEN when getRiskAssessment returns { success: false } and failClosed=false', async () => {
    mockGetRisk.mockResolvedValueOnce({ success: false, error: { code: 'DB_ERR', message: 'timeout' } } as never);
    await expect(fraudGuard(base)).resolves.toBeUndefined();
  });
});
