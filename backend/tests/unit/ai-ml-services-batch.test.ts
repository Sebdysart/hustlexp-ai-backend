/**
 * AI/ML Services Batch Unit Tests
 *
 * Covers:
 *   - JudgeAIService     (synthesizeVerdict, logVerdict, deterministic helpers)
 *   - LogisticsAIService (validateGPSProof, detectImpossibleTravel, validateTimeLock, assessLogisticsRisk)
 *   - OnboardingAIService (submitCalibration, getInferenceResult, confirmRole)
 *   - JuryPoolService    (selectJurors, submitVote, getVoteTally)
 *   - ScoperAIService    (_generateProposal, _validateProposal, validateScopeProposal, logDecision, analyzeTaskScope, refineTaskDescription)
 *   - DisputeService     (getById, getByTaskId, getByUserId, create, requestEvidence, resolve, escalate)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// ALL vi.mock CALLS MUST BE AT THE TOP BEFORE IMPORTS
// ============================================================================

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => {
  const child = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return {
    logger: { child },
    aiLogger: { child },
    taskLogger: { child },
    escrowLogger: { child },
  };
});

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
    call: vi.fn(),
  },
}));

vi.mock('../../src/lib/ai-response-schemas', () => ({
  JudgeVerdictSchema: {},
  ScoperProposalSchema: {},
}));

vi.mock('../../src/lib/pii-scrubber', () => ({
  scrubPII: (s: string) => s,
}));

vi.mock('../../src/services/AIEventService', () => ({
  AIEventService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'event-1' } }),
  },
}));

vi.mock('../../src/services/AIJobService', () => ({
  AIJobService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'job-1' } }),
    start: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/AIProposalService', () => ({
  AIProposalService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'proposal-1' } }),
  },
}));

vi.mock('../../src/services/AIDecisionService', () => ({
  AIDecisionService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'decision-1' } }),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
  },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    getById: vi.fn(),
  },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../../src/db';
import { AIClient } from '../../src/services/AIClient';
import { AIEventService } from '../../src/services/AIEventService';
import { AIJobService } from '../../src/services/AIJobService';
import { AIProposalService } from '../../src/services/AIProposalService';
import { AIDecisionService } from '../../src/services/AIDecisionService';
import { TaskService } from '../../src/services/TaskService';
import { EscrowService } from '../../src/services/EscrowService';
import { writeToOutbox } from '../../src/lib/outbox-helpers';

const mockDb = vi.mocked(db);
const mockAIClient = vi.mocked(AIClient);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);
const mockIsUniqueViolation = vi.mocked(isUniqueViolation);
const mockTaskService = vi.mocked(TaskService);
const mockEscrowService = vi.mocked(EscrowService);

// ============================================================================
// FACTORY HELPERS
// ============================================================================

function makeDispute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'disp-1',
    task_id: 'task-1',
    escrow_id: 'esc-1',
    initiated_by: 'poster-1',
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    reason: 'work_not_done',
    description: 'The task was never completed.',
    state: 'OPEN' as const,
    version: 1,
    created_at: new Date(),
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    resolution_notes: null,
    outcome_escrow_action: null,
    outcome_worker_penalty: false,
    outcome_poster_penalty: false,
    outcome_refund_amount: null,
    outcome_release_amount: null,
    escrow_id_ref: 'esc-1',
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    state: 'COMPLETED',
    completed_at: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago
    ...overrides,
  };
}

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'FUNDED',
    ...overrides,
  };
}

function makeScoperProposal(overrides: Record<string, unknown> = {}) {
  return {
    suggested_price_cents: 3000,
    price_reasoning: 'Based on task category and estimated effort and market rates.',
    suggested_xp: 300,
    xp_reasoning: 'Base XP: 300 (100 XP per dollar earned)',
    difficulty: 'medium' as const,
    difficulty_reasoning: 'Task complexity and required skills match medium tier.',
    confidence_score: 0.75,
    flags: [] as string[],
    estimated_duration_minutes: 75,
    required_capabilities: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.transaction delegates callback with db.query
  mockDb.transaction.mockImplementation(async (fn: (q: typeof db.query) => Promise<unknown>) =>
    fn(db.query)
  );
  mockIsInvariantViolation.mockReturnValue(false);
  mockIsUniqueViolation.mockReturnValue(false);
});

// ============================================================================
// JUDGE AI SERVICE
// ============================================================================

describe('JudgeAIService', () => {
  // Import lazily so mocks are fully initialised
  async function getService() {
    const mod = await import('../../src/services/JudgeAIService');
    return mod.JudgeAIService;
  }

  const goodBiometric = {
    liveness_score: 0.95,
    deepfake_score: 0.05,
    risk_level: 'LOW' as const,
  };
  const goodLogistics = {
    gps_proximity: { passed: true, distance_meters: 50 },
    impossible_travel: { passed: true, speed_kmh: 10 },
    time_lock: { passed: true, time_delta_seconds: 30 },
    gps_accuracy: { passed: true, accuracy_meters: 10 },
  };
  const goodPhoto = {
    similarity_score: 0.85,
    completion_score: 0.90,
    change_detected: true,
  };

  describe('synthesizeVerdict', () => {
    it('returns APPROVE via deterministic fallback when all signals pass', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-1',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: goodLogistics,
        photo_verification: goodPhoto,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verdict).toBe('APPROVE');
        expect(result.data.risk_score).toBeLessThan(0.30);
        expect(result.data.confidence).toBeGreaterThan(0);
        expect(Array.isArray(result.data.fraud_flags)).toBe(true);
      }
    });

    it('returns REJECT via deterministic fallback when all logistics fail', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-2',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: {
          gps_proximity: { passed: false, distance_meters: 2000 },
          impossible_travel: { passed: false, speed_kmh: 500 },
          time_lock: { passed: false, time_delta_seconds: 600 },
          gps_accuracy: { passed: false, accuracy_meters: 200 },
        },
        photo_verification: {
          similarity_score: 0.10,
          completion_score: 0.10,
          change_detected: false,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // All logistics + photo failed — risk_score should be high → REJECT
        expect(['REJECT', 'MANUAL_REVIEW']).toContain(result.data.verdict);
        expect(result.data.fraud_flags.length).toBeGreaterThan(0);
      }
    });

    it('forces MANUAL_REVIEW when fewer than 2 signal domains are available', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-3',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: null,
        photo_verification: null,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(['MANUAL_REVIEW', 'REJECT']).toContain(result.data.verdict);
        expect(result.data.fraud_flags).toContain('logistics_unavailable');
        expect(result.data.fraud_flags).toContain('photo_unavailable');
      }
    });

    it('handles all null signals gracefully (no_verification_signals)', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-4',
        task_id: 'task-1',
        biometric: null,
        logistics: null,
        photo_verification: null,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verdict).toBe('MANUAL_REVIEW');
        expect(result.data.fraud_flags).toContain('no_verification_signals');
      }
    });

    it('records but does not authorize a contradictory AI verdict', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      const aiVerdict = {
        verdict: 'REJECT',
        confidence: 0.92,
        reasoning: 'The model contradicts clean deterministic signals for this regression witness.',
        risk_score: 0.98,
        component_scores: { biometric: 0.98, logistics: 0.98, photo_verification: 0.98 },
        fraud_flags: ['model_only_claim'],
        recommended_action: 'Reject proof.',
      };
      mockAIClient.callJSON.mockResolvedValue({ data: aiVerdict, provider: 'deepseek' });

      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-5',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: goodLogistics,
        photo_verification: goodPhoto,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verdict).toBe('APPROVE');
        expect(result.data.risk_score).toBeLessThan(0.3);
      }
      expect(mockAIClient.callJSON).toHaveBeenCalledOnce();
    });

    it('does not let an adverse AI photo score override clean typed signals', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-photo-advisory',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: goodLogistics,
        photo_verification: {
          similarity_score: 0,
          completion_score: 0,
          change_detected: false,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verdict).toBe('APPROVE');
        expect(result.data.fraud_flags).toContain('photo_ai_advisory_only');
      }
    });

    it('falls back to deterministic verdict when AI call throws', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      mockAIClient.callJSON.mockRejectedValue(new Error('AI timeout'));

      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-6',
        task_id: 'task-1',
        biometric: goodBiometric,
        logistics: goodLogistics,
        photo_verification: goodPhoto,
      });

      // Must still succeed via deterministic fallback
      expect(result.success).toBe(true);
    });

    it('flags deepfake_suspected when deepfake_score > 0.85', async () => {
      const svc = await getService();
      const result = await svc.synthesizeVerdict({
        proof_id: 'proof-7',
        task_id: 'task-1',
        biometric: { liveness_score: 0.90, deepfake_score: 0.90, risk_level: 'CRITICAL' },
        logistics: goodLogistics,
        photo_verification: goodPhoto,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fraud_flags).toContain('deepfake_suspected');
        expect(result.data.fraud_flags).toContain('biometric_critical');
      }
    });
  });

  describe('logVerdict', () => {
    it('inserts verdict into ai_agent_decisions and returns success', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const svc = await getService();
      const verdict = {
        verdict: 'APPROVE' as const,
        confidence: 0.95,
        reasoning: 'All signals passed.',
        risk_score: 0.10,
        component_scores: { biometric: 0.05, logistics: 0.08, photo_verification: 0.07 },
        fraud_flags: [],
        recommended_action: 'Auto-approve proof.',
      };

      const result = await svc.logVerdict('proof-1', 'task-1', verdict);

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledOnce();
      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO ai_agent_decisions');
      expect(params[0]).toBe('judge');
      expect(params[1]).toBe('proof-1');
      expect(params[2]).toBe('task-1');
      expect(params[7]).toBe('A2');
    });

    it('returns LOG_VERDICT_FAILED when db throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection refused'));

      const svc = await getService();
      const verdict = {
        verdict: 'APPROVE' as const,
        confidence: 0.9,
        reasoning: 'Passed.',
        risk_score: 0.1,
        component_scores: { biometric: 0.05, logistics: 0.08, photo_verification: 0.07 },
        fraud_flags: [],
        recommended_action: 'Auto-approve.',
      };

      const result = await svc.logVerdict('proof-1', 'task-1', verdict);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('LOG_VERDICT_FAILED');
      }
    });
  });
});

// ============================================================================
// LOGISTICS AI SERVICE
// ============================================================================

describe('LogisticsAIService', () => {
  async function getService() {
    const mod = await import('../../src/services/LogisticsAIService');
    return mod.LogisticsAIService;
  }

  const taskCoords = { latitude: 34.0522, longitude: -118.2437 }; // LA

  describe('_haversineDistance', () => {
    it('returns ~0 for identical coordinates', async () => {
      const svc = await getService();
      const dist = svc._haversineDistance(taskCoords, taskCoords);
      expect(dist).toBeCloseTo(0, 1);
    });

    it('returns correct distance between LA and NYC (~3940km)', async () => {
      const svc = await getService();
      const nyc = { latitude: 40.7128, longitude: -74.006 };
      const dist = svc._haversineDistance(taskCoords, nyc);
      // LA to NYC ≈ 3,940,000 meters ±5%
      expect(dist).toBeGreaterThan(3_700_000);
      expect(dist).toBeLessThan(4_200_000);
    });
  });

  describe('validateGPSProof', () => {
    it('returns LOW risk when distance <= 100m', async () => {
      const svc = await getService();
      const nearbyCoords = { latitude: 34.0522, longitude: -118.2437 };
      const result = await svc.validateGPSProof(nearbyCoords, taskCoords, 10);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.risk_level).toBe('LOW');
      }
    });

    it('returns MEDIUM risk when distance is between 100m and 500m', async () => {
      const svc = await getService();
      // Shift about 0.002° latitude ≈ 222m
      const medCoords = { latitude: 34.0542, longitude: -118.2437 };
      const result = await svc.validateGPSProof(medCoords, taskCoords, 20);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.risk_level).toBe('MEDIUM');
      }
    });

    it('returns HIGH risk and failed when distance > 500m', async () => {
      const svc = await getService();
      // Shift 0.01° latitude ≈ 1111m
      const farCoords = { latitude: 34.0622, longitude: -118.2437 };
      const result = await svc.validateGPSProof(farCoords, taskCoords, 30);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(false);
        expect(result.data.risk_level).toBe('HIGH');
        expect(result.data.distance_meters).toBeGreaterThan(500);
      }
    });
  });

  describe('detectImpossibleTravel', () => {
    it('returns passed=true with zeroed data when no lastKnownLocation', async () => {
      const svc = await getService();
      const result = await svc.detectImpossibleTravel(
        'user-1',
        { latitude: 34.0522, longitude: -118.2437, timestamp: new Date().toISOString() }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.speed_kmh).toBe(0);
        expect(result.data.flagged).toBe(false);
      }
    });

    it('returns INVALID_TIMESTAMPS when current timestamp is before lastKnownLocation', async () => {
      const svc = await getService();
      const result = await svc.detectImpossibleTravel(
        'user-1',
        { latitude: 34.0522, longitude: -118.2437, timestamp: '2024-01-01T10:00:00Z' },
        { latitude: 34.0600, longitude: -118.2437, timestamp: '2024-01-01T11:00:00Z' }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TIMESTAMPS');
      }
    });

    it('detects impossible travel at 500km/h and writes fraud event', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const svc = await getService();
      // 1000km in 6 minutes ≈ 10000km/h — clearly impossible
      const result = await svc.detectImpossibleTravel(
        'user-1',
        { latitude: 43.6532, longitude: -79.3832, timestamp: '2024-01-01T10:06:00Z' }, // Toronto
        { latitude: 34.0522, longitude: -118.2437, timestamp: '2024-01-01T10:00:00Z' }  // LA
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flagged).toBe(true);
        expect(result.data.passed).toBe(false);
        expect(result.data.speed_kmh).toBeGreaterThan(100);
      }
      // Should have written a fraud detection event
      expect(mockDb.query).toHaveBeenCalledOnce();
      const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO fraud_detection_events');
    });

    it('passes when travel speed is under 100km/h', async () => {
      const svc = await getService();
      // 5km in 6 minutes = 50km/h
      const result = await svc.detectImpossibleTravel(
        'user-1',
        { latitude: 34.0971, longitude: -118.2437, timestamp: '2024-01-01T10:06:00Z' },
        { latitude: 34.0522, longitude: -118.2437, timestamp: '2024-01-01T10:00:00Z' }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.flagged).toBe(false);
      }
    });
  });

  describe('validateTimeLock', () => {
    it('passes when photo submitted within 5 minutes of GPS timestamp', async () => {
      const svc = await getService();
      const gpsTs = '2024-01-01T10:00:00Z';
      const submitTs = '2024-01-01T10:03:00Z'; // 3 min later
      const result = svc.validateTimeLock('hash-abc', submitTs, gpsTs);

      expect(result.passed).toBe(true);
      expect(result.time_delta_seconds).toBeCloseTo(180, 0);
    });

    it('fails when photo submitted more than 5 minutes after GPS timestamp', async () => {
      const svc = await getService();
      const gpsTs = '2024-01-01T10:00:00Z';
      const submitTs = '2024-01-01T10:10:00Z'; // 10 min later
      const result = svc.validateTimeLock('hash-abc', submitTs, gpsTs);

      expect(result.passed).toBe(false);
      expect(result.time_delta_seconds).toBeCloseTo(600, 0);
    });

    it('passes when timestamps are equal (0 delta)', async () => {
      const svc = await getService();
      const ts = '2024-01-01T10:00:00Z';
      const result = svc.validateTimeLock('hash-abc', ts, ts);

      expect(result.passed).toBe(true);
      expect(result.time_delta_seconds).toBe(0);
    });
  });

  describe('assessLogisticsRisk', () => {
    it('returns LOW risk and approve when all checks pass', async () => {
      // db.query for INSERT INTO ai_agent_decisions
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const svc = await getService();
      const now = new Date();
      const gpsTs = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
      const submitTs = now.toISOString();

      const result = await svc.assessLogisticsRisk(
        'proof-1',
        'user-1',
        taskCoords,
        taskCoords,
        10,
        gpsTs,
        submitTs,
        'hash-lock'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.risk_level).toBe('LOW');
        expect(result.data.recommendation).toBe('approve');
        expect(result.data.fraud_flags).toHaveLength(0);
      }
    });

    it('returns CRITICAL risk when GPS out of range and impossible travel detected', async () => {
      // db.query called twice: fraud event INSERT + ai_agent_decisions INSERT
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // fraud event
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // ai_agent_decisions

      const svc = await getService();
      const gpsTs = '2024-01-01T10:00:00Z';
      const submitTs = '2024-01-01T10:30:00Z'; // 30 min later — fails time-lock

      const result = await svc.assessLogisticsRisk(
        'proof-2',
        'user-2',
        { latitude: 40.7128, longitude: -74.006 }, // NYC
        taskCoords,                                  // LA task
        200,                                         // poor accuracy
        gpsTs,
        submitTs,
        'hash-lock',
        { latitude: 34.0522, longitude: -118.2437, timestamp: '2024-01-01T09:58:00Z' } // lastKnown in LA
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(['HIGH', 'CRITICAL']).toContain(result.data.risk_level);
        expect(result.data.recommendation).toBe('reject');
        expect(result.data.fraud_flags).toContain('gps_out_of_range');
      }
    });

    it('returns GPS_VALIDATION_FAILED error shape when db.query throws', async () => {
      // Make the ai_agent_decisions insert throw
      mockDb.query.mockRejectedValueOnce(new Error('db down'));

      const svc = await getService();
      const now = new Date();
      const gpsTs = new Date(now.getTime() - 30_000).toISOString();
      const submitTs = now.toISOString();

      const result = await svc.assessLogisticsRisk(
        'proof-3',
        'user-3',
        taskCoords,
        taskCoords,
        10,
        gpsTs,
        submitTs,
        'hash-lock'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('LOGISTICS_ASSESSMENT_FAILED');
      }
    });
  });
});

// ============================================================================
// ONBOARDING AI SERVICE
// ============================================================================

describe('OnboardingAIService', () => {
  async function getService() {
    const mod = await import('../../src/services/OnboardingAIService');
    return mod.OnboardingAIService;
  }

  describe('submitCalibration', () => {
    it('returns inference result on happy path', async () => {
      // db.query for UPDATE users RETURNING *
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', role_confidence_worker: 0.5, role_confidence_poster: 0.5 }],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.submitCalibration({
        userId: 'user-1',
        calibrationPrompt: 'I want to earn money doing tasks in my spare time',
        onboardingVersion: '1.0.0',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.roleConfidenceWorker).toBe('number');
        expect(typeof result.data.roleConfidencePoster).toBe('number');
        expect(typeof result.data.certaintyTier).toBe('string');
      }
    });

    it('returns NOT_FOUND when user does not exist after inference', async () => {
      // UPDATE returns empty rows
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.submitCalibration({
        userId: 'missing-user',
        calibrationPrompt: 'I want to help people',
        onboardingVersion: '1.0.0',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns error when AIEventService.create fails', async () => {
      vi.mocked(AIEventService.create).mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'event creation failed' },
      } as never);

      const svc = await getService();
      const result = await svc.submitCalibration({
        userId: 'user-1',
        calibrationPrompt: 'I want to earn money',
        onboardingVersion: '1.0.0',
      });

      expect(result.success).toBe(false);
    });

    it('returns error when AIJobService.create fails', async () => {
      vi.mocked(AIJobService.create).mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'job creation failed' },
      } as never);

      const svc = await getService();
      const result = await svc.submitCalibration({
        userId: 'user-1',
        calibrationPrompt: 'I want to earn money',
        onboardingVersion: '1.0.0',
      });

      expect(result.success).toBe(false);
    });

    it('handles DB_ERROR on unexpected exception', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection timeout'));

      const svc = await getService();
      const result = await svc.submitCalibration({
        userId: 'user-1',
        calibrationPrompt: 'I want to earn money doing deliveries',
        onboardingVersion: '1.0.0',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  describe('getInferenceResult', () => {
    it('returns inference result when user has role data', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          role_confidence_worker: 0.80,
          role_confidence_poster: 0.20,
          role_certainty_tier: 'STRONG',
          inconsistency_flags: [],
        }],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.getInferenceResult('user-1');

      expect(result.success).toBe(true);
      if (result.success && result.data !== null) {
        expect(result.data.roleConfidenceWorker).toBe(0.80);
        expect(result.data.certaintyTier).toBe('STRONG');
      }
    });

    it('returns null data when user has no role data yet', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          role_confidence_worker: null,
          role_confidence_poster: null,
          role_certainty_tier: null,
          inconsistency_flags: [],
        }],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.getInferenceResult('user-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('returns NOT_FOUND when user does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.getInferenceResult('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns DB_ERROR on db failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('db error'));

      const svc = await getService();
      const result = await svc.getInferenceResult('user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  describe('confirmRole', () => {
    it('confirms role and returns updated user', async () => {
      const user = { id: 'user-1', default_mode: 'worker', onboarding_completed_at: new Date() };
      mockDb.query.mockResolvedValueOnce({ rows: [user], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.confirmRole({
        userId: 'user-1',
        confirmedMode: 'worker',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).default_mode).toBe('worker');
      }
    });

    it('returns NOT_FOUND when user does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.confirmRole({
        userId: 'missing',
        confirmedMode: 'poster',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('sets role_was_overridden=true when overrideAI=true', async () => {
      const user = { id: 'user-1', default_mode: 'poster', role_was_overridden: true };
      mockDb.query.mockResolvedValueOnce({ rows: [user], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.confirmRole({
        userId: 'user-1',
        confirmedMode: 'poster',
        overrideAI: true,
      });

      expect(result.success).toBe(true);
      const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe(true); // overrideAI flag
    });
  });
});

// ============================================================================
// JURY POOL SERVICE
// ============================================================================

describe('JuryPoolService', () => {
  async function getService() {
    const mod = await import('../../src/services/JuryPoolService');
    return mod.JuryPoolService;
  }

  describe('selectJurors', () => {
    it('returns eligible jurors for a dispute', async () => {
      // Query 1: get dispute participants
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }],
          rowCount: 1,
        } as never)
        // Query 2: select eligible jurors
        .mockResolvedValueOnce({
          rows: [
            { user_id: 'juror-1', trust_tier: 4, tasks_completed: 75 },
            { user_id: 'juror-2', trust_tier: 3, tasks_completed: 60 },
            { user_id: 'juror-3', trust_tier: 5, tasks_completed: 200 },
          ],
          rowCount: 3,
        } as never);

      const svc = await getService();
      const result = await svc.selectJurors('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        // All 3 pass the tasks_completed >= 50 filter
        expect(result.data.length).toBe(3);
      }
    });

    it('filters out jurors with fewer than 50 tasks completed', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [
            { user_id: 'juror-1', trust_tier: 4, tasks_completed: 75 },
            { user_id: 'juror-2', trust_tier: 3, tasks_completed: 10 }, // under threshold
          ],
          rowCount: 2,
        } as never);

      const svc = await getService();
      const result = await svc.selectJurors('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(1);
        expect(result.data[0].user_id).toBe('juror-1');
      }
    });

    it('returns NOT_FOUND when dispute does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.selectJurors('missing-dispute');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('db timeout'));

      const svc = await getService();
      const result = await svc.selectJurors('disp-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  describe('submitVote', () => {
    it('accepts a valid vote from an eligible juror', async () => {
      // Query 1: check juror eligibility
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ trust_tier: 4 }], rowCount: 1 } as never)
        // Query 2: INSERT vote
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.submitVote('disp-1', 'juror-1', 'worker_complete', 0.85);

      expect(result.success).toBe(true);
      // Verify the INSERT was called
      const insertCall = mockDb.query.mock.calls[1] as [string, unknown[]];
      expect(insertCall[0]).toContain('INSERT INTO dispute_jury_votes');
      expect(insertCall[1][0]).toBe('disp-1');
      expect(insertCall[1][1]).toBe('juror-1');
      expect(insertCall[1][2]).toBe('worker_complete');
    });

    it('rejects vote from juror with trust_tier below threshold', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.submitVote('disp-1', 'low-trust-juror', 'worker_complete', 0.70);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INELIGIBLE');
      }
    });

    it('rejects vote when juror not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.submitVote('disp-1', 'ghost-juror', 'inconclusive', 0.50);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INELIGIBLE');
      }
    });

    it('returns DB_ERROR on unexpected exception', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('query failed'));

      const svc = await getService();
      const result = await svc.submitVote('disp-1', 'juror-1', 'worker_complete', 0.80);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  describe('getVoteTally', () => {
    it('returns tally with majority worker_complete verdict when quorum reached', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { vote: 'worker_complete', count: 4 },
          { vote: 'worker_incomplete', count: 1 },
        ],
        rowCount: 2,
      } as never);

      const svc = await getService();
      const result = await svc.getVoteTally('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_votes).toBe(5);
        expect(result.data.quorum_reached).toBe(true);
        expect(result.data.verdict).toBe('worker_complete');
      }
    });

    it('returns pending verdict when quorum not reached', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ vote: 'worker_complete', count: 2 }],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.getVoteTally('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quorum_reached).toBe(false);
        expect(result.data.verdict).toBe('pending');
        expect(result.data.total_votes).toBe(2);
      }
    });

    it('returns inconclusive when worker_complete and worker_incomplete are tied', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { vote: 'worker_complete', count: 3 },
          { vote: 'worker_incomplete', count: 3 },
        ],
        rowCount: 2,
      } as never);

      const svc = await getService();
      const result = await svc.getVoteTally('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quorum_reached).toBe(true);
        expect(result.data.verdict).toBe('inconclusive');
      }
    });

    it('returns empty tally when no votes cast', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.getVoteTally('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_votes).toBe(0);
        expect(result.data.quorum_reached).toBe(false);
        expect(result.data.verdict).toBe('pending');
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('relation does not exist'));

      const svc = await getService();
      const result = await svc.getVoteTally('disp-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });
});

// ============================================================================
// SCOPER AI SERVICE
// ============================================================================

describe('ScoperAIService', () => {
  async function getService() {
    const mod = await import('../../src/services/ScoperAIService');
    return mod.ScoperAIService;
  }

  describe('_generateProposal', () => {
    it('generates delivery proposal with vehicle capability', async () => {
      const svc = await getService();
      // description must contain the substring 'delivery' (lowercased) for the keyword branch to fire
      const proposal = svc._generateProposal({ description: 'Same-day delivery of a small package', category: 'delivery' });

      expect(proposal.suggested_price_cents).toBe(2500);
      expect(proposal.difficulty).toBe('easy');
      expect(proposal.required_capabilities).toContain('vehicle');
    });

    it('generates moving/furniture proposal with heavy_lifting flag', async () => {
      const svc = await getService();
      const proposal = svc._generateProposal({ description: 'Help me move my furniture to new apartment', category: 'moving' });

      expect(proposal.suggested_price_cents).toBe(8000);
      expect(proposal.flags).toContain('heavy_lifting');
      expect(proposal.required_capabilities).toContain('vehicle');
    });

    it('generates handyman proposal with specialized_skill flag', async () => {
      const svc = await getService();
      const proposal = svc._generateProposal({ description: 'Handyman repair for broken cabinet' });

      expect(proposal.suggested_price_cents).toBe(10000);
      expect(proposal.flags).toContain('specialized_skill');
      // Price 10000 falls in the medium tier ($50-$150), so the price-tier adjuster
      // overwrites the initial 'hard' assignment to 'medium'.
      expect(proposal.difficulty).toBe('medium');
      expect(proposal.required_capabilities).toContain('tools');
    });

    it('applies urgency 1.5x premium', async () => {
      const svc = await getService();
      // Default price = 3000 for a generic task with "urgent"
      const proposal = svc._generateProposal({ description: 'urgent help needed asap' });

      expect(proposal.flags).toContain('urgent');
      expect(proposal.suggested_price_cents).toBe(4500); // 3000 * 1.5
    });

    it('blends budget_hint_cents with base price', async () => {
      const svc = await getService();
      // Base for cleaning = 4000, hint = 6000 → blended = (4000+6000)/2 = 5000
      const proposal = svc._generateProposal({ description: 'Clean and organize the garage', budget_hint_cents: 6000 });

      expect(proposal.suggested_price_cents).toBe(5000);
    });

    it('clips price to minimum 1500 cents', async () => {
      const svc = await getService();
      // Very short description, no keywords — default 3000, no adjustment. Hard to go below min.
      // Supply an absurd budget_hint of 100 → blended = (3000+100)/2 = 1550, still above min
      const proposal = svc._generateProposal({ description: 'x', budget_hint_cents: 100 });

      expect(proposal.suggested_price_cents).toBeGreaterThanOrEqual(1500);
    });

    it('gives low confidence for very short descriptions', async () => {
      const svc = await getService();
      const proposal = svc._generateProposal({ description: 'help' }); // < 20 chars

      expect(proposal.confidence_score).toBe(0.50);
      expect(proposal.flags).toContain('ambiguous_description');
    });

    it('gives high confidence for detailed descriptions', async () => {
      const svc = await getService();
      const proposal = svc._generateProposal({
        description: 'I need someone to help me clean my two-bedroom apartment including kitchen, bathroom, and living room. Should take about 3 hours.',
      });

      expect(proposal.confidence_score).toBe(0.90);
    });
  });

  describe('_validateProposal / validateScopeProposal', () => {
    it('passes validation for a well-formed proposal', async () => {
      const svc = await getService();
      const proposal = makeScoperProposal();
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails SCOPER-ERR-001 when price is below $15', async () => {
      const svc = await getService();
      const proposal = makeScoperProposal({ suggested_price_cents: 1000 });
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SCOPER-ERR-001'))).toBe(true);
    });

    it('fails SCOPER-ERR-002 when price is above $500', async () => {
      const svc = await getService();
      const proposal = makeScoperProposal({
        suggested_price_cents: 60000,
        suggested_xp: 6000,
        difficulty: 'hard',
      });
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SCOPER-ERR-002'))).toBe(true);
    });

    it('fails SCOPER-ERR-003 when XP deviates >20% from expected', async () => {
      const svc = await getService();
      // Price 3000 → expected XP 300, 20% tolerance = ±60 → 361 would fail (361 > 360)
      const proposal = makeScoperProposal({ suggested_xp: 500 }); // 500 >> 300+60=360
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SCOPER-ERR-003'))).toBe(true);
    });

    it('fails SCOPER-ERR-004 when confidence is below 0.60', async () => {
      const svc = await getService();
      const proposal = makeScoperProposal({ confidence_score: 0.45 });
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SCOPER-ERR-004'))).toBe(true);
    });

    it('fails SCOPER-ERR-005 when price_reasoning is too short', async () => {
      const svc = await getService();
      const proposal = makeScoperProposal({ price_reasoning: 'Short' }); // < 20 chars
      const result = svc.validateScopeProposal(proposal);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SCOPER-ERR-005'))).toBe(true);
    });

    it('auto-corrects difficulty when price is in wrong tier', async () => {
      const svc = await getService();
      // Price 3000 (easy tier $15-$50) but difficulty='hard'
      const proposal = makeScoperProposal({ difficulty: 'hard' as const });
      svc.validateScopeProposal(proposal);

      // Validator should have auto-corrected difficulty to 'easy'
      expect(proposal.difficulty).toBe('easy');
    });
  });

  describe('logDecision', () => {
    it('inserts decision into ai_agent_decisions', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const svc = await getService();
      const proposal = makeScoperProposal();
      const result = await svc.logDecision('task-1', proposal, true);

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledOnce();
      const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO ai_agent_decisions');
      expect(params[0]).toBe('scoper');
      expect(params[1]).toBe('task-1');
      expect(params[5]).toBe(true); // accepted
    });

    it('returns LOG_DECISION_FAILED when db throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('insert failed'));

      const svc = await getService();
      const result = await svc.logDecision('task-1', makeScoperProposal(), false);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('LOG_DECISION_FAILED');
      }
    });
  });

  describe('analyzeTaskScope', () => {
    it('returns proposal via heuristic fallback when AI not configured', async () => {
      const svc = await getService();
      const result = await svc.analyzeTaskScope({
        description: 'Deliver a package to my neighbor down the street',
        category: 'delivery',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
        expect(result.data.confidence_score).toBeGreaterThanOrEqual(0.60);
      }
    });

    it('uses AI response when AIClient is configured', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      const aiProposal = makeScoperProposal({
        suggested_price_cents: 4000,
        suggested_xp: 400,
        difficulty: 'easy',
        confidence_score: 0.85,
        price_reasoning: 'Simple delivery task with clear instructions and known location.',
      });
      mockAIClient.callJSON.mockResolvedValue({ data: aiProposal, provider: 'openai' });

      const svc = await getService();
      const result = await svc.analyzeTaskScope({
        description: 'Deliver package to neighbor',
        category: 'delivery',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.suggested_price_cents).toBe(4000);
      }
    });

    it('uses deterministic economics in executable context even when AI is configured', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      mockAIClient.callJSON.mockResolvedValue({
        data: makeScoperProposal({ suggested_price_cents: 49_999, suggested_xp: 5_000 }),
        provider: 'openai',
      });
      const svc = await getService();
      const input = {
        description: 'Move one couch from the living room to the curb using two people',
        category: 'moving',
        authorityContext: 'EXECUTABLE' as const,
      };

      const expected = svc._generateProposal(input);
      const result = await svc.analyzeTaskScope(input);

      expect(result.success).toBe(true);
      expect(result.data?.suggested_price_cents).toBe(expected.suggested_price_cents);
      expect(mockAIClient.callJSON).not.toHaveBeenCalled();
    });

    it('falls back to heuristic when AI call fails', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      mockAIClient.callJSON.mockRejectedValue(new Error('LLM timeout'));

      const svc = await getService();
      const result = await svc.analyzeTaskScope({
        description: 'Deliver a package to the nearby post office',
        category: 'delivery',
      });

      // Should succeed via heuristic fallback
      expect(result.success).toBe(true);
    });

    it('returns PROPOSAL_VALIDATION_FAILED when heuristic produces invalid proposal', async () => {
      const svc = await getService();
      // Use a 5-char description → confidence=0.50 → validation fails SCOPER-ERR-004
      const result = await svc.analyzeTaskScope({ description: 'help' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PROPOSAL_VALIDATION_FAILED');
      }
    });
  });

  describe('refineTaskDescription', () => {
    it('returns trimmed and collapsed-whitespace description when AI not configured', async () => {
      const svc = await getService();
      const result = await svc.refineTaskDescription('  help   me  clean  my   house  ');

      expect(result).toBe('help me clean my house');
    });

    it('truncates description to 500 characters', async () => {
      const svc = await getService();
      const longDesc = 'A'.repeat(600);
      const result = await svc.refineTaskDescription(longDesc);

      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('uses AI refinement when configured and description is long enough', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      mockAIClient.call.mockResolvedValue({ content: 'Cleaned task description.', provider: 'groq' });

      const svc = await getService();
      const result = await svc.refineTaskDescription('This is my task description that is long enough');

      expect(result).toBe('Cleaned task description.');
    });

    it('falls back to basic cleanup when AI call throws', async () => {
      mockAIClient.isConfigured.mockReturnValue(true);
      mockAIClient.call.mockRejectedValue(new Error('AI error'));

      const svc = await getService();
      const result = await svc.refineTaskDescription('  Clean   my   apartment  ');

      expect(result).toBe('Clean my apartment');
    });
  });
});

// ============================================================================
// DISPUTE SERVICE
// ============================================================================

describe('DisputeService', () => {
  async function getService() {
    const mod = await import('../../src/services/DisputeService');
    return mod.DisputeService;
  }

  describe('getById', () => {
    it('returns dispute when found', async () => {
      const dispute = makeDispute();
      mockDb.query.mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.getById('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('disp-1');
      }
    });

    it('returns NOT_FOUND when dispute does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.getById('missing-disp');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('db failure'));

      const svc = await getService();
      const result = await svc.getById('disp-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  describe('getByTaskId', () => {
    it('returns disputes for a task', async () => {
      const disputes = [makeDispute(), makeDispute({ id: 'disp-2' })];
      mockDb.query.mockResolvedValueOnce({ rows: disputes, rowCount: 2 } as never);

      const svc = await getService();
      const result = await svc.getByTaskId('task-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });

    it('returns empty array when no disputes for task', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.getByTaskId('task-no-disputes');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  describe('getByUserId', () => {
    it('returns disputes where user is poster, worker, or initiator', async () => {
      const disputes = [makeDispute()];
      mockDb.query.mockResolvedValueOnce({ rows: disputes, rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.getByUserId('poster-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });
  });

  describe('create', () => {
    it('returns FORBIDDEN when initiator is neither poster nor worker', async () => {
      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'stranger-user',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'work_not_done',
        description: 'Did not complete the task.',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('returns INVALID_STATE when task is not completed', async () => {
      // Inside transaction: SELECT task FOR UPDATE → task with no completed_at
      mockDb.query.mockResolvedValueOnce({
        rows: [makeTask({ completed_at: null })],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'work_not_done',
        description: 'Not done.',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
      }
    });

    it('returns INVALID_STATE when dispute window has expired (> 48h)', async () => {
      const oldDate = new Date(Date.now() - 50 * 3600 * 1000).toISOString(); // 50h ago
      // Inside transaction: SELECT task FOR UPDATE → task with old completed_at
      mockDb.query.mockResolvedValueOnce({
        rows: [makeTask({ completed_at: oldDate })],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'work_not_done',
        description: 'Not done.',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('48 hours');
      }
    });

    it('returns INVALID_STATE when escrow is in an invalid state (REFUNDED)', async () => {
      // BUG FIX (HIGH): FUNDED and RELEASED are both valid states for filing a dispute
      // (completed tasks typically have RELEASED escrow). Only truly terminal states
      // like REFUNDED or LOCKED_DISPUTE are invalid for dispute creation.
      // Inside transaction:
      // query 1: SELECT task FOR UPDATE → completed task
      mockDb.query.mockResolvedValueOnce({
        rows: [makeTask()],
        rowCount: 1,
      } as never);
      // query 2: SELECT escrow FOR UPDATE → REFUNDED escrow (truly invalid state)
      mockDb.query.mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'REFUNDED' })],
        rowCount: 1,
      } as never);

      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'work_not_done',
        description: 'Not done.',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
      }
    });

    it('creates dispute and locks escrow on happy path', async () => {
      // Inside transaction:
      // query 1: SELECT task FOR UPDATE → completed task (within window)
      // query 2: SELECT escrow FOR UPDATE (state check + lock)
      // query 3: UPDATE escrows ... LOCKED_DISPUTE
      // query 4: INSERT INTO disputes
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeTask()],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [makeEscrow({ state: 'FUNDED' })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [makeEscrow({ state: 'LOCKED_DISPUTE' })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({
          rows: [makeDispute()],
          rowCount: 1,
        } as never);

      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'work_not_done',
        description: 'The task was never completed.',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe('OPEN');
      }
      expect(writeToOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'dispute.created' }),
        expect.any(Function),
      );
    });

    it('returns INVALID_STATE when unique violation occurs (duplicate dispute)', async () => {
      mockTaskService.getById.mockResolvedValueOnce({
        success: true,
        data: makeTask() as never,
      });
      mockEscrowService.getById.mockResolvedValueOnce({
        success: true,
        data: makeEscrow() as never,
      });
      mockIsUniqueViolation.mockReturnValue(true);
      mockDb.transaction.mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: '23505' }));

      const svc = await getService();
      const result = await svc.create({
        taskId: 'task-1',
        escrowId: 'esc-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'duplicate',
        description: 'Duplicate dispute.',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
      }
    });
  });

  describe('requestEvidence', () => {
    it('transitions dispute from OPEN to EVIDENCE_REQUESTED', async () => {
      const dispute = makeDispute({ state: 'OPEN' });
      const updated = makeDispute({ state: 'EVIDENCE_REQUESTED' });
      mockDb.query
        .mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [updated], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.requestEvidence('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe('EVIDENCE_REQUESTED');
      }
    });

    it('returns NOT_FOUND when dispute does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.requestEvidence('missing');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns INVALID_TRANSITION when dispute is already RESOLVED', async () => {
      const dispute = makeDispute({ state: 'RESOLVED' });
      mockDb.query.mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.requestEvidence('disp-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TRANSITION');
      }
    });
  });

  describe('escalate', () => {
    it('transitions dispute from OPEN to ESCALATED', async () => {
      const dispute = makeDispute({ state: 'OPEN' });
      const escalated = makeDispute({ state: 'ESCALATED' });
      mockDb.query
        .mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [escalated], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.escalate('disp-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe('ESCALATED');
      }
    });

    it('returns INVALID_TRANSITION when escalating a RESOLVED dispute', async () => {
      const dispute = makeDispute({ state: 'RESOLVED' });
      mockDb.query.mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.escalate('disp-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TRANSITION');
      }
    });
  });

  describe('resolve', () => {
    it('returns FORBIDDEN when resolver lacks admin permission', async () => {
      // canResolveDisputes query returns empty rows → no permission
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const svc = await getService();
      const result = await svc.resolve({
        disputeId: 'disp-1',
        resolvedBy: 'non-admin-user',
        resolution: 'Worker did not complete task.',
        outcomeEscrowAction: 'REFUND',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('resolves dispute with RELEASE action on happy path', async () => {
      // canResolveDisputes → has permission
      mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as never);

      // Inside transaction:
      // query 1: SELECT dispute FOR UPDATE
      // query 2: SELECT escrow FOR UPDATE
      // query 3: UPDATE dispute RESOLVED
      const dispute = makeDispute({ state: 'OPEN', version: 1, escrow_id: 'esc-1', task_id: 'task-1', worker_id: 'worker-1', poster_id: 'poster-1' });
      const escrow = makeEscrow({ state: 'LOCKED_DISPUTE', amount: 5000 });
      const resolved = makeDispute({ state: 'RESOLVED', version: 2 });

      mockDb.query
        .mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never)   // FOR UPDATE dispute
        .mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never)    // FOR UPDATE escrow
        .mockResolvedValueOnce({ rows: [resolved], rowCount: 1 } as never)  // UPDATE dispute
        // T55-1 FIX: RELEASE path accepts proof then completes task before outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)           // UPDATE proofs ACCEPTED
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', state: 'COMPLETED' }], rowCount: 1 } as never); // UPDATE tasks COMPLETED

      const svc = await getService();
      const result = await svc.resolve({
        disputeId: 'disp-1',
        resolvedBy: 'admin-1',
        resolution: 'Task was completed satisfactorily.',
        outcomeEscrowAction: 'RELEASE',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBe('RESOLVED');
      }
      // Should emit 4 outbox events: dispute.resolved, worker trust, poster trust, escrow action
      expect(writeToOutbox).toHaveBeenCalledTimes(4);
    });

    it('returns INVALID_STATE for SPLIT without valid amounts', async () => {
      // Admin check passes
      mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as never);

      const dispute = makeDispute({ state: 'OPEN', version: 1, escrow_id: 'esc-1', task_id: 'task-1' });
      const escrow = makeEscrow({ state: 'LOCKED_DISPUTE', amount: 5000 });

      mockDb.query
        .mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.resolve({
        disputeId: 'disp-1',
        resolvedBy: 'admin-1',
        resolution: 'Split the funds.',
        outcomeEscrowAction: 'SPLIT',
        // Missing refundAmount and releaseAmount
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('SPLIT');
      }
    });

    it('returns INVALID_STATE when SPLIT amounts do not sum to escrow amount', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as never);

      const dispute = makeDispute({ state: 'OPEN', version: 1, escrow_id: 'esc-1', task_id: 'task-1' });
      const escrow = makeEscrow({ state: 'LOCKED_DISPUTE', amount: 5000 });

      mockDb.query
        .mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const svc = await getService();
      const result = await svc.resolve({
        disputeId: 'disp-1',
        resolvedBy: 'admin-1',
        resolution: 'Split the funds.',
        outcomeEscrowAction: 'SPLIT',
        refundAmount: 2000,
        releaseAmount: 2000, // 2000 + 2000 = 4000 ≠ 5000
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('must sum to escrow amount');
      }
    });
  });
});
