/**
 * Biometric Router Unit Tests
 *
 * Tests all protected procedures:
 * - submitBiometricProof (mutation)
 * - analyzeFacePhoto (mutation)
 * - createLivenessSession (mutation)
 * - getLivenessResult (query)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/BiometricVerificationService', () => ({
  BiometricVerificationService: {
    analyzeProofSubmission: vi.fn(),
    analyzeFacePhoto: vi.fn(),
    createLivenessSession: vi.fn(),
    getLivenessSessionResult: vi.fn(),
  },
}));

vi.mock('../../src/services/LogisticsAIService', () => ({
  LogisticsAIService: {
    validateGPSProof: vi.fn(),
    detectImpossibleTravel: vi.fn(),
    validateTimeLock: vi.fn(),
  },
}));

vi.mock('../../src/services/GDPRService', () => ({
  GDPRService: {
    hasBiometricConsent: vi.fn(),
    createRequest: vi.fn(),
    getRequestById: vi.fn(),
    getUserRequests: vi.fn(),
    cancelRequest: vi.fn(),
    getConsentStatus: vi.fn(),
    updateConsent: vi.fn(),
  },
}));

vi.mock('../../src/lib/url-safety', () => ({
  validateSafeUrl: vi.fn().mockReturnValue({ safe: true }),
}));

vi.mock('../../src/services/PrivateMediaDeliveryService', () => ({
  issueSingleParticipantMediaAccess: vi.fn().mockResolvedValue({
    downloadUrl: 'https://signed.example/private-proof.jpg?signature=test',
    expiresAt: '2026-07-20T18:05:00.000Z',
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { biometricRouter } from '../../src/routers/biometric';
import { BiometricVerificationService } from '../../src/services/BiometricVerificationService';
import { LogisticsAIService } from '../../src/services/LogisticsAIService';
import { GDPRService } from '../../src/services/GDPRService';

const mockDb = vi.mocked(db);
const mockBiometric = vi.mocked(BiometricVerificationService);
const mockLogistics = vi.mocked(LogisticsAIService);
const mockGDPR = vi.mocked(GDPRService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeCaller() {
  return biometricRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
    firebaseUid: 'fb-1',
  });
}

const BASE_PROOF_INPUT = {
  proof_id: UUID2,
  task_id: UUID1,
  photo_url: 'https://example.com/photo.jpg',
  gps_coordinates: { latitude: 40.7128, longitude: -74.006 },
  gps_accuracy_meters: 10,
  gps_timestamp: '2025-01-01T12:00:00Z',
  task_location: { latitude: 40.713, longitude: -74.005 },
  lidar_depth_map_url: 'https://example.com/untrusted-depth.bin',
  time_lock_hash: 'abc123hash',
  submission_timestamp: '2025-01-01T12:00:30Z',
};

function canonicalProofContext(overrides: Record<string, unknown> = {}) {
  return {
    worker_id: UUID1,
    submitter_id: UUID1,
    biometric_signal_status: 'NOT_RUN',
    photo_url: `media/proof/${UUID1}/${UUID1}/${UUID2}.jpg`,
    lidar_depth_map_url: null,
    gps_coordinates: BASE_PROOF_INPUT.gps_coordinates,
    gps_accuracy_meters: BASE_PROOF_INPUT.gps_accuracy_meters,
    location_lat: BASE_PROOF_INPUT.task_location.latitude,
    location_lng: BASE_PROOF_INPUT.task_location.longitude,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('biometric router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // submitBiometricProof
  // =========================================================================
  describe('submitBiometricProof', () => {
    it('binds the claimed proof to the task and worker before analysis', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.submitBiometricProof(BASE_PROOF_INPUT))
        .rejects.toThrow('Proof verification record not found');

      const [sql] = mockDb.query.mock.calls[0];
      expect(String(sql)).toContain('JOIN proofs');
      expect(String(sql)).toContain('proof_submissions');
      expect(mockBiometric.analyzeProofSubmission).not.toHaveBeenCalled();
    });

    it('uses stored proof media, GPS, and task coordinates instead of client claims', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          worker_id: UUID1,
          submitter_id: UUID1,
          biometric_signal_status: 'NOT_RUN',
          photo_url: `media/proof/${UUID1}/${UUID1}/${UUID2}.jpg`,
          lidar_depth_map_url: null,
          gps_coordinates: { latitude: 47.6062, longitude: -122.3321 },
          gps_accuracy_meters: 7,
          location_lat: 47.6063,
          location_lng: -122.3322,
        }],
        rowCount: 1,
      } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: {
          recommendation: 'approve', flags: [],
          scores: { liveness_score: 0.9, deepfake_score: 0.1, risk_level: 'LOW' },
          reasoning: 'Stored evidence assessed',
        },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: true,
        data: { passed: true, distance_meters: 10, risk_level: 'LOW' },
      } as any);
      mockLogistics.detectImpossibleTravel.mockResolvedValue({
        success: true,
        data: { flagged: false, speed_kmh: 0 },
      } as any);
      mockLogistics.validateTimeLock.mockReturnValue({ passed: true, time_delta_seconds: 30 } as any);

      const result = await makeCaller().submitBiometricProof(BASE_PROOF_INPUT);

      expect(result.success).toBe(true);
      expect(mockBiometric.analyzeProofSubmission).toHaveBeenCalledWith(
        UUID2,
        'https://signed.example/private-proof.jpg?signature=test',
        undefined,
      );
      expect(mockLogistics.validateGPSProof).toHaveBeenCalledWith(
        { latitude: 47.6062, longitude: -122.3321 },
        { latitude: 47.6063, longitude: -122.3322 },
        7,
      );
    });

    it('returns approve recommendation when all checks pass', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: {
          recommendation: 'approve',
          flags: [],
          scores: { liveness: 0.95, deepfake: 0.02 },
          reasoning: 'All checks passed',
        },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: true,
        data: { passed: true, distance_meters: 15, risk_level: 'LOW' },
      } as any);
      // Last known location query
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockLogistics.detectImpossibleTravel.mockResolvedValue({
        success: true,
        data: { flagged: false, speed_kmh: 0 },
      } as any);
      mockLogistics.validateTimeLock.mockReturnValue({
        passed: true,
        time_delta_seconds: 30,
      } as any);

      const caller = makeCaller();
      const result = await caller.submitBiometricProof(BASE_PROOF_INPUT);

      expect(result.success).toBe(true);
      expect(result.recommendation).toBe('approve');
      expect(result.flags).toHaveLength(0);
    });

    it('returns reject when biometric recommendation is reject', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: {
          recommendation: 'reject',
          flags: ['deepfake_detected'],
          scores: { liveness: 0.3, deepfake: 0.9 },
          reasoning: 'Deepfake detected',
        },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: true,
        data: { passed: true, distance_meters: 10, risk_level: 'LOW' },
      } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockLogistics.detectImpossibleTravel.mockResolvedValue({
        success: true,
        data: { flagged: false, speed_kmh: 0 },
      } as any);
      mockLogistics.validateTimeLock.mockReturnValue({ passed: true, time_delta_seconds: 30 } as any);

      const caller = makeCaller();
      const result = await caller.submitBiometricProof(BASE_PROOF_INPUT);

      expect(result.recommendation).toBe('reject');
      expect(result.flags).toContain('deepfake_detected');
    });

    it('throws FORBIDDEN when BIPA consent not given', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(false);

      const caller = makeCaller();
      await expect(caller.submitBiometricProof(BASE_PROOF_INPUT))
        .rejects.toThrow('BIPA_CONSENT_REQUIRED');
    });

    it('throws BAD_REQUEST when biometric verification fails', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: false,
        error: { message: 'Photo analysis failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.submitBiometricProof(BASE_PROOF_INPUT))
        .rejects.toThrow('Photo analysis failed');
    });

    it('throws BAD_REQUEST when GPS validation fails', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: { recommendation: 'approve', flags: [], scores: {}, reasoning: '' },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: false,
        error: { message: 'GPS too far' },
      } as any);

      const caller = makeCaller();
      await expect(caller.submitBiometricProof(BASE_PROOF_INPUT))
        .rejects.toThrow('GPS too far');
    });

    it('flags impossible travel', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: { recommendation: 'approve', flags: [], scores: {}, reasoning: '' },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: true,
        data: { passed: true, distance_meters: 10, risk_level: 'LOW' },
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ latitude: 51.5, longitude: -0.1, timestamp: '2025-01-01T11:59:00Z' }],
        rowCount: 1,
      } as any);
      mockLogistics.detectImpossibleTravel.mockResolvedValue({
        success: true,
        data: { flagged: true, speed_kmh: 5000 },
      } as any);
      mockLogistics.validateTimeLock.mockReturnValue({ passed: true, time_delta_seconds: 30 } as any);

      const caller = makeCaller();
      const result = await caller.submitBiometricProof(BASE_PROOF_INPUT);

      expect(result.recommendation).toBe('reject');
      expect(result.flags).toContain('impossible_travel');
    });

    it('flags time lock failure as manual_review', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofContext()], rowCount: 1 } as any);
      mockGDPR.hasBiometricConsent.mockResolvedValue(true);
      mockBiometric.analyzeProofSubmission.mockResolvedValue({
        success: true,
        data: { recommendation: 'approve', flags: [], scores: {}, reasoning: '' },
      } as any);
      mockLogistics.validateGPSProof.mockResolvedValue({
        success: true,
        data: { passed: true, distance_meters: 10, risk_level: 'LOW' },
      } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockLogistics.detectImpossibleTravel.mockResolvedValue({
        success: true,
        data: { flagged: false, speed_kmh: 0 },
      } as any);
      mockLogistics.validateTimeLock.mockReturnValue({ passed: false, time_delta_seconds: 600 } as any);

      const caller = makeCaller();
      const result = await caller.submitBiometricProof(BASE_PROOF_INPUT);

      expect(result.recommendation).toBe('manual_review');
      expect(result.flags).toContain('time_lock_failed');
    });
  });

  // =========================================================================
  // analyzeFacePhoto
  // =========================================================================
  describe('analyzeFacePhoto', () => {
    it('rejects direct face-photo URLs before consent lookup or analysis', async () => {
      const caller = makeCaller();
      await expect(caller.analyzeFacePhoto({ photo_url: 'https://example.com/face.jpg' }))
        .rejects.toThrow('Direct face-photo analysis is disabled');
      expect(mockGDPR.hasBiometricConsent).not.toHaveBeenCalled();
      expect(mockBiometric.analyzeFacePhoto).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // createLivenessSession
  // =========================================================================
  describe('createLivenessSession', () => {
    it('returns session data on success', async () => {
      const data = { sessionId: 'session-123' };
      mockBiometric.createLivenessSession.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.createLivenessSession();

      expect(result).toEqual(data);
    });

    it('throws on failure', async () => {
      mockBiometric.createLivenessSession.mockResolvedValue({
        success: false,
        error: { message: 'AWS error' },
      } as any);

      const caller = makeCaller();
      await expect(caller.createLivenessSession()).rejects.toThrow('AWS error');
    });
  });

  // =========================================================================
  // getLivenessResult
  // =========================================================================
  describe('getLivenessResult', () => {
    it('returns liveness result on success', async () => {
      const data = { confidence: 98.5 };
      mockBiometric.getLivenessSessionResult.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getLivenessResult({ sessionId: 'session-123' });

      expect(result).toEqual(data);
    });

    it('throws on failure', async () => {
      mockBiometric.getLivenessSessionResult.mockResolvedValue({
        success: false,
        error: { message: 'Session expired' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getLivenessResult({ sessionId: 'session-123' }))
        .rejects.toThrow('Session expired');
    });
  });
});
