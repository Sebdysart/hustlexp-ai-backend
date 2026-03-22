/**
 * ProofService Unit Tests
 *
 * Tests proof lifecycle: getById, getByTaskId, getPhotos,
 * submit, addPhoto, review (with AI verification pipeline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

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
  },
}));

vi.mock('../../src/services/LogisticsAIService', () => ({
  LogisticsAIService: {
    validateGPSProof: vi.fn(),
  },
}));

vi.mock('../../src/services/JudgeAIService', () => ({
  JudgeAIService: {
    synthesizeVerdict: vi.fn(),
    logVerdict: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/PhotoVerificationService', () => ({
  PhotoVerificationService: {
    compareBeforeAfter: vi.fn(),
  },
}));

// Mock the Redis cache module used by the advisory lock (FIX YY-03).
// By default the mock Redis client returns 'OK' for set() (lock acquired)
// and resolves for del() (lock released). Individual tests can override
// set() to return null to simulate lock contention.
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisDel = vi.fn().mockResolvedValue(1);
const mockRedisClient = { set: mockRedisSet, del: mockRedisDel };

vi.mock('../../src/cache/redis', () => ({
  getClient: vi.fn(() => mockRedisClient),
}));

import { db, isInvariantViolation } from '../../src/db';
import { ProofService } from '../../src/services/ProofService';
import { BiometricVerificationService } from '../../src/services/BiometricVerificationService';
import { LogisticsAIService } from '../../src/services/LogisticsAIService';
import { JudgeAIService } from '../../src/services/JudgeAIService';
import { PhotoVerificationService } from '../../src/services/PhotoVerificationService';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore advisory lock defaults: set() returns 'OK' (acquired), del() resolves.
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
});

// ============================================================================
// HELPERS
// ============================================================================

function makeProof(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proof-1',
    task_id: 'task-1',
    submitter_id: 'user-1',
    state: 'SUBMITTED',
    description: 'Proof description',
    submitted_at: new Date(),
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makePhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'photo-1',
    proof_id: 'proof-1',
    storage_key: 'proofs/photo1.jpg',
    content_type: 'image/jpeg',
    file_size_bytes: 12345,
    checksum_sha256: 'abc123',
    capture_time: null,
    sequence_number: 1,
    created_at: new Date(),
    ...overrides,
  };
}

function makeVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'video-1',
    proof_id: 'proof-1',
    storage_key: 'proofs/video1.mp4',
    content_type: 'video/mp4',
    file_size_bytes: 500000,
    duration_seconds: 30,
    sequence_number: 1,
    created_at: new Date(),
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('ProofService', () => {
  // --------------------------------------------------------------------------
  // getById
  // --------------------------------------------------------------------------
  describe('getById', () => {
    it('returns proof when found', async () => {
      const proof = makeProof();
      mockDb.query.mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never);

      const result = await ProofService.getById('proof-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(proof);
      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM proofs WHERE id = $1',
        ['proof-1']
      );
    });

    it('returns NOT_FOUND when proof does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ProofService.getById('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns DB_ERROR on database failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Connection lost'));

      const result = await ProofService.getById('proof-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Connection lost');
      }
    });
  });

  // --------------------------------------------------------------------------
  // getByTaskId
  // --------------------------------------------------------------------------
  describe('getByTaskId', () => {
    it('returns proof when found for task', async () => {
      const proof = makeProof();
      mockDb.query.mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never);

      const result = await ProofService.getByTaskId('task-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(proof);
    });

    it('returns null when no proof exists for task', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ProofService.getByTaskId('task-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeNull();
    });

    it('returns DB_ERROR on failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('timeout'));

      const result = await ProofService.getByTaskId('task-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

  // --------------------------------------------------------------------------
  // getPhotos
  // --------------------------------------------------------------------------
  describe('getPhotos', () => {
    it('returns photos for proof', async () => {
      const photos = [makePhoto(), makePhoto({ id: 'photo-2', sequence_number: 2 })];
      mockDb.query.mockResolvedValueOnce({ rows: photos, rowCount: 2 } as never);

      const result = await ProofService.getPhotos('proof-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(2);
    });

    it('returns empty array when no photos', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ProofService.getPhotos('proof-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([]);
    });

    it('returns DB_ERROR on failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('query error'));

      const result = await ProofService.getPhotos('proof-1');

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // submit
  // --------------------------------------------------------------------------
  describe('submit', () => {
    it('creates proof in PENDING then transitions to SUBMITTED', async () => {
      const pendingProof = makeProof({ state: 'PENDING' });
      const submittedProof = makeProof({ state: 'SUBMITTED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ worker_id: 'user-1', state: 'ACCEPTED' }], rowCount: 1 } as never) // task lookup (FIX 1+2)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // duplicate check (FIX 6)
        .mockResolvedValueOnce({ rows: [pendingProof], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [submittedProof], rowCount: 1 } as never); // UPDATE

      const result = await ProofService.submit({
        taskId: 'task-1',
        submitterId: 'user-1',
        description: 'Done!',
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('SUBMITTED');
      expect(mockDb.query).toHaveBeenCalledTimes(4); // task lookup + dup check + INSERT + UPDATE
    });

    it('returns INVARIANT_VIOLATION on constraint failure', async () => {
      const error = { code: 'HX001', message: 'invariant' };
      mockIsInvariantViolation.mockReturnValueOnce(true);
      // task lookup succeeds, dup check succeeds, then INSERT throws invariant violation
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ worker_id: 'user-1', state: 'ACCEPTED' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockRejectedValueOnce(error);

      const result = await ProofService.submit({
        taskId: 'task-1',
        submitterId: 'user-1',
        description: 'proof content',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX001');
    });

    it('returns DB_ERROR on generic failure during INSERT', async () => {
      // task lookup succeeds, dup check succeeds, then INSERT throws a generic error
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ worker_id: 'user-1', state: 'ACCEPTED' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockRejectedValueOnce(new Error('timeout'));

      const result = await ProofService.submit({
        taskId: 'task-1',
        submitterId: 'user-1',
        description: 'proof content',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });

    // T53-1: Verify the proof submission race condition fix.
    // The task row must be locked with FOR UPDATE before the duplicate-proof check
    // and INSERT so that concurrent submissions cannot both pass the guard.
    it('T53-1: uses FOR UPDATE on task row inside transaction to prevent concurrent submissions', async () => {
      const pendingProof = makeProof({ state: 'PENDING' });
      const submittedProof = makeProof({ state: 'SUBMITTED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ worker_id: 'user-1', state: 'in_progress' }], rowCount: 1 } as never) // task FOR UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)   // dup check FOR UPDATE on proofs
        .mockResolvedValueOnce({ rows: [pendingProof], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [submittedProof], rowCount: 1 } as never); // UPDATE to SUBMITTED

      const result = await ProofService.submit({
        taskId: 'task-1',
        submitterId: 'user-1',
        description: 'Completed',
      });

      expect(result.success).toBe(true);
      // Verify the transaction was used (not a bare db.query)
      expect(mockDb.transaction).toHaveBeenCalledOnce();
      // Verify FOR UPDATE was present in the task lock query
      const firstCallSql: string = mockDb.query.mock.calls[0][0];
      expect(firstCallSql).toMatch(/FOR UPDATE/i);
    });

    it('T53-1: throws CONFLICT when a duplicate pending/submitted proof exists (race guard)', async () => {
      // Simulate: task lock passes, but duplicate proof check finds an existing proof
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ worker_id: 'user-1', state: 'in_progress' }], rowCount: 1 } as never) // task FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ id: 'existing-proof' }], rowCount: 1 } as never); // existing PENDING proof

      await expect(
        ProofService.submit({
          taskId: 'task-1',
          submitterId: 'user-1',
          description: 'My proof',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('T53-1: throws UNAUTHORIZED when submitter is not the assigned worker', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ worker_id: 'other-worker', state: 'in_progress' }], rowCount: 1,
      } as never);

      await expect(
        ProofService.submit({
          taskId: 'task-1',
          submitterId: 'user-1', // not the assigned worker
          description: 'Fake proof',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // --------------------------------------------------------------------------
  // addPhoto
  // --------------------------------------------------------------------------
  describe('addPhoto', () => {
    it('adds photo with explicit sequence number', async () => {
      const photo = makePhoto();
      mockDb.query.mockResolvedValueOnce({ rows: [photo], rowCount: 1 } as never);

      const result = await ProofService.addPhoto({
        proofId: 'proof-1',
        storageKey: 'proofs/photo1.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 12345,
        checksumSha256: 'abc123',
        sequenceNumber: 1,
      });

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(1); // No count query
    });

    it('auto-calculates sequence number via FOR UPDATE transaction if not provided', async () => {
      // The transaction mock delegates to mockDb.query, so two mockDb.query calls are needed:
      // call 0: COUNT FOR UPDATE (returns count=2), call 1: INSERT (returns photo row with seqNum=3)
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as never) // COUNT FOR UPDATE
        .mockResolvedValueOnce({ rows: [makePhoto({ sequence_number: 3 })], rowCount: 1 } as never); // INSERT

      const result = await ProofService.addPhoto({
        proofId: 'proof-1',
        storageKey: 'proofs/photo3.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 5000,
        checksumSha256: 'xyz789',
      });

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('returns DB_ERROR on failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('insert failed'));

      const result = await ProofService.addPhoto({
        proofId: 'proof-1',
        storageKey: 'key',
        contentType: 'image/png',
        fileSizeBytes: 1,
        checksumSha256: 'hash',
        sequenceNumber: 1,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

  // --------------------------------------------------------------------------
  // addVideo
  // --------------------------------------------------------------------------
  describe('addVideo', () => {
    it('adds video with explicit sequence number', async () => {
      const video = makeVideo();
      mockDb.query.mockResolvedValueOnce({ rows: [video], rowCount: 1 } as never);

      const result = await ProofService.addVideo({
        proofId: 'proof-1',
        storageKey: 'proofs/video1.mp4',
        contentType: 'video/mp4',
        fileSizeBytes: 500000,
        durationSeconds: 30,
        sequenceNumber: 1,
      });

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(1); // No count query when sequenceNumber is provided
    });

    it('auto-calculates sequence number via FOR UPDATE transaction if not provided', async () => {
      // The transaction mock delegates to mockDb.query, so two mockDb.query calls are needed:
      // call 0: COUNT query (returns count=1), call 1: INSERT (returns video row with seqNum=2)
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never) // COUNT FOR UPDATE
        .mockResolvedValueOnce({ rows: [makeVideo({ sequence_number: 2 })], rowCount: 1 } as never); // INSERT

      const result = await ProofService.addVideo({
        proofId: 'proof-1',
        storageKey: 'proofs/video2.mp4',
        fileSizeBytes: 250000,
        durationSeconds: 15,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sequence_number).toBe(2);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('returns DB_ERROR on failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('insert failed'));

      const result = await ProofService.addVideo({
        proofId: 'proof-1',
        storageKey: 'key',
        contentType: 'video/mp4',
        fileSizeBytes: 1,
        sequenceNumber: 1,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

  // --------------------------------------------------------------------------
  // review
  // --------------------------------------------------------------------------
  describe('review', () => {
    it('rejects proof when not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ProofService.review({
        proofId: 'nonexistent',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('throws CONFLICT when advisory lock is already held by another reviewer (FIX YY-03)', async () => {
      // Phase 1 SELECT succeeds — proof is SUBMITTED and transition is valid
      const proof = makeProof({ state: 'SUBMITTED' });
      mockDb.query.mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never);
      // T53-8 ownership check — reviewer 'admin-2' is the poster
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'admin-2' }], rowCount: 1 } as never);

      // Simulate lock contention: Redis SET NX returns null (key already exists)
      mockRedisSet.mockResolvedValueOnce(null);

      await expect(
        ProofService.review({
          proofId: 'proof-1',
          reviewerId: 'admin-2',
          decision: 'ACCEPTED',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // AI pipeline must NOT have been invoked — that is the whole point of the fix
      expect(JudgeAIService.synthesizeVerdict).not.toHaveBeenCalled();
      expect(BiometricVerificationService.analyzeProofSubmission).not.toHaveBeenCalled();
    });

    it('rejects invalid state transition', async () => {
      const proof = makeProof({ state: 'ACCEPTED' }); // terminal state
      mockDb.query.mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'REJECTED',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_TRANSITION');
    });

    it('rejects proof via REJECTION decision (no AI pipeline)', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });
      const rejectedProof = makeProof({ state: 'REJECTED', reviewed_by: 'admin-1', rejection_reason: 'Bad quality' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                             // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)          // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)            // SELECT state FOR UPDATE (inside tx)
        .mockResolvedValueOnce({ rows: [rejectedProof], rowCount: 1 } as never);                    // UPDATE (inside tx)

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'REJECTED',
        reason: 'Bad quality',
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('REJECTED');
    });

    it('accepts proof when JudgeAI approves', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });
      const acceptedProof = makeProof({ state: 'ACCEPTED', reviewed_by: 'admin-1' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                               // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)                           // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ description: 'Fix pipe', before_photo_url: null }], rowCount: 1 } as never) // SELECT task desc (AI pipeline)
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)                             // SELECT state FOR UPDATE (inside tx)
        .mockResolvedValueOnce({ rows: [acceptedProof], rowCount: 1 } as never);                                     // UPDATE (inside tx)

      vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValueOnce({
        success: true,
        data: {
          verdict: 'APPROVE',
          risk_score: 0.1,
          reasoning: 'All clear',
          fraud_flags: [],
          component_scores: {},
          recommended_action: 'none',
        },
      } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('ACCEPTED');
    });

    it('blocks acceptance when JudgeAI rejects', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                                   // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)                               // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ description: 'Clean house', before_photo_url: null }], rowCount: 1 } as never); // SELECT task desc (AI pipeline)
      // JUDGE_REJECTED path — no transaction/UPDATE reached

      vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValueOnce({
        success: true,
        data: {
          verdict: 'REJECT',
          risk_score: 0.95,
          reasoning: 'Fraudulent submission detected',
          fraud_flags: ['deepfake'],
          component_scores: {},
          recommended_action: 'block',
        },
      } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('JUDGE_REJECTED');
    });

    it('allows acceptance when JudgeAI returns MANUAL_REVIEW (human override)', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });
      const acceptedProof = makeProof({ state: 'ACCEPTED', reviewed_by: 'admin-1' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                               // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)                           // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ description: 'Yard work', before_photo_url: null }], rowCount: 1 } as never) // SELECT task desc (AI pipeline)
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)                             // SELECT state FOR UPDATE (inside tx)
        .mockResolvedValueOnce({ rows: [acceptedProof], rowCount: 1 } as never);                                     // UPDATE (inside tx)

      vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValueOnce({
        success: true,
        data: {
          verdict: 'MANUAL_REVIEW',
          risk_score: 0.6,
          reasoning: 'Medium risk',
          fraud_flags: ['unusual_pattern'],
          component_scores: {},
          recommended_action: 'review',
        },
      } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(true);
    });

    it('proceeds with acceptance when JudgeAI synthesis fails', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });
      const acceptedProof = makeProof({ state: 'ACCEPTED', reviewed_by: 'admin-1' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                             // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)                         // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ description: 'task', before_photo_url: null }], rowCount: 1 } as never)  // SELECT task desc (AI pipeline)
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)                           // SELECT state FOR UPDATE (inside tx)
        .mockResolvedValueOnce({ rows: [acceptedProof], rowCount: 1 } as never);                                   // UPDATE (inside tx)

      vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValueOnce({
        success: false,
        error: { code: 'AI_ERROR', message: 'Service unavailable' },
      } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(true);
    });

    it('runs biometric + GPS + photo pipelines when data available', async () => {
      const proof = makeProof({
        state: 'SUBMITTED',
        photo_url: 'https://r2.dev/photo.jpg',
        gps_coordinates: { lat: 40.7128, lng: -74.006 },
        gps_accuracy_meters: 10,
        lidar_depth_map_url: 'https://r2.dev/lidar.bin',
      });
      const acceptedProof = makeProof({ state: 'ACCEPTED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                                                   // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)                                                // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ location_lat: 40.7128, location_lng: -74.006 }], rowCount: 1 } as never)                        // task location (GPS pipeline)
        .mockResolvedValueOnce({ rows: [{ description: 'task', before_photo_url: 'https://r2.dev/before.jpg' }], rowCount: 1 } as never)  // task desc (photo pipeline)
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)                                                  // SELECT state FOR UPDATE (inside tx)
        .mockResolvedValueOnce({ rows: [acceptedProof], rowCount: 1 } as never);                                                          // UPDATE (inside tx)

      vi.mocked(BiometricVerificationService.analyzeProofSubmission).mockResolvedValueOnce({
        success: true,
        data: { scores: { liveness: 0.95, deepfake: 0.05 } },
      } as never);

      vi.mocked(LogisticsAIService.validateGPSProof).mockResolvedValueOnce({
        success: true,
        data: { passed: true, distance_meters: 15 },
      } as never);

      vi.mocked(PhotoVerificationService.compareBeforeAfter).mockResolvedValueOnce({
        success: true,
        data: { similarity_score: 0.8, completion_score: 0.9, change_detected: true },
      } as never);

      vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValueOnce({
        success: true,
        data: {
          verdict: 'APPROVE',
          risk_score: 0.05,
          reasoning: 'All checks passed',
          fraud_flags: [],
          component_scores: {},
          recommended_action: 'none',
        },
      } as never);

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'ACCEPTED',
      });

      expect(result.success).toBe(true);
      expect(BiometricVerificationService.analyzeProofSubmission).toHaveBeenCalled();
      expect(LogisticsAIService.validateGPSProof).toHaveBeenCalled();
      expect(PhotoVerificationService.compareBeforeAfter).toHaveBeenCalled();
      expect(JudgeAIService.synthesizeVerdict).toHaveBeenCalled();
    });

    it('handles invariant violation during review', async () => {
      const proof = makeProof({ state: 'SUBMITTED' });

      const invariantError = { code: 'HX003', message: 'invariant' };
      mockIsInvariantViolation.mockReturnValueOnce(true);

      mockDb.query
        .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                      // SELECT proof (outside tx)
        .mockResolvedValueOnce({ rows: [{ poster_id: 'admin-1' }], rowCount: 1 } as never)   // T53-8 ownership check
        .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)     // SELECT state FOR UPDATE (inside tx)
        .mockRejectedValueOnce(invariantError);                                               // UPDATE throws invariant violation (inside tx)

      const result = await ProofService.review({
        proofId: 'proof-1',
        reviewerId: 'admin-1',
        decision: 'REJECTED',
        reason: 'Bad',
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX003');
    });
  });
});
