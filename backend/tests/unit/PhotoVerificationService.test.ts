/**
 * PhotoVerificationService Unit Tests
 *
 * Covers validateCapture (capture source, timestamp, GPS) and
 * compareBeforeAfter (no-API fallback, recommendation thresholds).
 *
 * Constants from service:
 *   MAX_CAPTURE_AGE_MINUTES = 5
 *   MAX_GPS_DISTANCE_METERS = 500
 *   COMPLETION_THRESHOLD     = 0.65  (auto-approve when score >= 0.65 && confidence >= 0.6)
 *   REVIEW_THRESHOLD         = 0.40  (reject when score < 0.40)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must appear before any import that triggers module evaluation
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

// Mock the circuit-breaker used by compareBeforeAfter
vi.mock('../../src/middleware/circuit-breaker', () => ({
  openaiBreaker: {
    execute: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { openaiBreaker } from '../../src/middleware/circuit-breaker';
import { PhotoVerificationService } from '../../src/services/PhotoVerificationService';

const mockDb = vi.mocked(db);
const mockBreaker = vi.mocked(openaiBreaker);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROOF_ID = 'proof-abc-123';
const TASK_LOCATION = { lat: 41.8781, lng: -87.6298 };

/** Returns a fresh Date that is `minutesAgo` minutes in the past */
function minutesAgo(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

/** Returns a fresh Date that is `minutesFromNow` minutes in the future */
function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.query succeeds (the UPDATE to proof_submissions)
  mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('PhotoVerificationService', () => {
  // -------------------------------------------------------------------------
  // validateCapture — capture source checks
  // -------------------------------------------------------------------------
  describe('validateCapture — capture source', () => {
    it('fails when capture_source is "gallery"', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'gallery',
        exif_timestamp: minutesAgo(1),
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.success).toBe(true);
      expect(result.data!.passed).toBe(false);
      expect(result.data!.failures).toContain(
        'GALLERY_UPLOAD_REJECTED: Photo must be taken live within the app'
      );
    });

    it('passes and adds a warning when capture_source is "unknown"', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'unknown',
        exif_timestamp: minutesAgo(1),
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.success).toBe(true);
      // unknown source alone is a warning, not a hard failure
      expect(result.data!.failures).toHaveLength(0);
      expect(result.data!.warnings.some(w => w.includes('CAPTURE_SOURCE_UNKNOWN'))).toBe(true);
    });

    it('passes when capture_source is "live_camera" with a fresh timestamp', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'live_camera',
        exif_timestamp: minutesAgo(1),
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: 'iPhone 15',
      });

      expect(result.success).toBe(true);
      expect(result.data!.passed).toBe(true);
      expect(result.data!.failures).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // validateCapture — timestamp freshness (MAX_CAPTURE_AGE_MINUTES = 5)
  // -------------------------------------------------------------------------
  describe('validateCapture — timestamp freshness', () => {
    it('fails when the photo is older than 5 minutes', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'live_camera',
        exif_timestamp: minutesAgo(10), // 10 minutes old
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.data!.passed).toBe(false);
      expect(result.data!.failures.some(f => f.includes('STALE_PHOTO'))).toBe(true);
    });

    it('passes when the photo is exactly 1 minute old (within the 5-minute window)', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'live_camera',
        exif_timestamp: minutesAgo(1),
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.data!.passed).toBe(true);
      expect(result.data!.failures).toHaveLength(0);
    });

    it('fails when the timestamp is in the future (manipulation)', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'live_camera',
        exif_timestamp: minutesFromNow(2),
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.data!.passed).toBe(false);
      expect(result.data!.failures.some(f => f.includes('FUTURE_TIMESTAMP'))).toBe(true);
    });

    it('adds a warning when no EXIF timestamp is present', async () => {
      const result = await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'live_camera',
        exif_timestamp: null,
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(result.data!.failures).toHaveLength(0);
      expect(result.data!.warnings.some(w => w.includes('NO_EXIF_TIMESTAMP'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // validateCapture — GPS proximity (MAX_GPS_DISTANCE_METERS = 500)
  // -------------------------------------------------------------------------
  describe('validateCapture — GPS proximity', () => {
    it('fails when the photo GPS is more than 500m from the task location', async () => {
      // Chicago downtown vs. ~10km away (roughly Evanston)
      const result = await PhotoVerificationService.validateCapture(
        PROOF_ID,
        {
          capture_source: 'live_camera',
          exif_timestamp: minutesAgo(1),
          exif_gps_lat: 42.0451, // ~10km north
          exif_gps_lng: -87.6877,
          exif_device_model: null,
        },
        TASK_LOCATION
      );

      expect(result.data!.passed).toBe(false);
      expect(result.data!.failures.some(f => f.includes('GPS_MISMATCH'))).toBe(true);
    });

    it('passes when the photo GPS is within 500m of the task location', async () => {
      // Task and photo at essentially the same coordinates
      const result = await PhotoVerificationService.validateCapture(
        PROOF_ID,
        {
          capture_source: 'live_camera',
          exif_timestamp: minutesAgo(1),
          exif_gps_lat: TASK_LOCATION.lat + 0.001, // ~111m offset
          exif_gps_lng: TASK_LOCATION.lng,
          exif_device_model: null,
        },
        TASK_LOCATION
      );

      expect(result.data!.passed).toBe(true);
      expect(result.data!.failures).toHaveLength(0);
    });

    it('adds a warning when GPS data is missing and a task location is provided', async () => {
      const result = await PhotoVerificationService.validateCapture(
        PROOF_ID,
        {
          capture_source: 'live_camera',
          exif_timestamp: minutesAgo(1),
          exif_gps_lat: null,
          exif_gps_lng: null,
          exif_device_model: null,
        },
        TASK_LOCATION
      );

      expect(result.data!.failures).toHaveLength(0);
      expect(result.data!.warnings.some(w => w.includes('NO_GPS_DATA'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // validateCapture — DB write
  // -------------------------------------------------------------------------
  describe('validateCapture — DB write', () => {
    it('writes the validation result to proof_submissions regardless of pass/fail', async () => {
      await PhotoVerificationService.validateCapture(PROOF_ID, {
        capture_source: 'gallery',
        exif_timestamp: null,
        exif_gps_lat: null,
        exif_gps_lng: null,
        exif_device_model: null,
      });

      expect(mockDb.query).toHaveBeenCalledOnce();
      const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('UPDATE proof_submissions');
      expect(sql).toContain('capture_validation_passed');
    });
  });

  // -------------------------------------------------------------------------
  // compareBeforeAfter — fallback when OPENAI_API_KEY not set
  // -------------------------------------------------------------------------
  describe('compareBeforeAfter — no API key fallback', () => {
    it('returns manual_review recommendation with confidence 0 when OPENAI_API_KEY is absent', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const result = await PhotoVerificationService.compareBeforeAfter(
          'task-1',
          'https://example.com/before.jpg',
          'https://example.com/after.jpg',
          'Clean the gutters'
        );

        expect(result.success).toBe(true);
        expect(result.data!.recommendation).toBe('manual_review');
        expect(result.data!.confidence).toBe(0.0);
        expect(result.data!.ai_assessment).toContain('manual review');
      } finally {
        if (originalKey !== undefined) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // compareBeforeAfter — recommendation thresholds
  // COMPLETION_THRESHOLD = 0.65, REVIEW_THRESHOLD = 0.40
  // approve: completion_score >= 0.65 AND confidence >= 0.6
  // reject:  completion_score < 0.40
  // manual:  otherwise
  // -------------------------------------------------------------------------
  describe('compareBeforeAfter — recommendation thresholds', () => {
    function mockOpenAIResponse(payload: {
      similarity_score: number;
      completion_score: number;
      change_detected: boolean;
      assessment: string;
      confidence: number;
    }) {
      const responseBody = JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      });
      mockBreaker.execute.mockImplementation(async (fn: () => Promise<unknown>) => {
        // Return a Response-like object
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(responseBody),
        };
      });
    }

    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key';
    });

    afterEach(() => {
      delete process.env.OPENAI_API_KEY;
    });

    it('recommends "approve" when completion_score >= 0.65 and confidence >= 0.6', async () => {
      mockOpenAIResponse({
        similarity_score: 0.9,
        completion_score: 0.8,
        change_detected: true,
        assessment: 'Work is clearly done.',
        confidence: 0.9,
      });

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-1',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Mow the lawn'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('approve');
      expect(result.data!.completion_score).toBe(0.8);
    });

    it('recommends "reject" when completion_score < 0.40', async () => {
      mockOpenAIResponse({
        similarity_score: 0.8,
        completion_score: 0.2,
        change_detected: false,
        assessment: 'No change visible.',
        confidence: 0.85,
      });

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-2',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Paint the fence'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('reject');
    });

    it('recommends "manual_review" when completion_score is between 0.40 and 0.65', async () => {
      mockOpenAIResponse({
        similarity_score: 0.7,
        completion_score: 0.5,
        change_detected: true,
        assessment: 'Partial completion.',
        confidence: 0.7,
      });

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-3',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Clear the driveway'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('manual_review');
    });

    it('recommends "manual_review" when score >= 0.65 but confidence is below 0.6', async () => {
      // High completion but low confidence → manual review, not auto-approve
      mockOpenAIResponse({
        similarity_score: 0.8,
        completion_score: 0.7,
        change_detected: true,
        assessment: 'Looks done but uncertain.',
        confidence: 0.3,
      });

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-4',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Repair the step'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('manual_review');
    });

    it('falls back to manual_review when the AI JSON is unparseable', async () => {
      // Breaker returns garbled content
      mockBreaker.execute.mockImplementation(async (fn: () => Promise<unknown>) => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'not valid JSON at all !!!' } }],
        }),
      }));

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-5',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Fix the gate'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('manual_review');
      expect(result.data!.confidence).toBe(0.0);
    });

    it('falls back to manual_review on network/API error', async () => {
      mockBreaker.execute.mockImplementation(async (fn: () => Promise<unknown>) => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }));

      const result = await PhotoVerificationService.compareBeforeAfter(
        'task-6',
        'https://example.com/before.jpg',
        'https://example.com/after.jpg',
        'Install new lock'
      );

      expect(result.success).toBe(true);
      expect(result.data!.recommendation).toBe('manual_review');
    });
  });
});
