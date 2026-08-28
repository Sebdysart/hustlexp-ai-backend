/**
 * AIJobService Unit Tests
 *
 * Tests create, start, complete, fail, timeout, kill, and getById.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { AIJobService } from '../../src/services/AIJobService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const baseJob = {
  id: 'job1',
  event_id: 'evt1',
  subsystem: 'onboarding',
  status: 'PENDING',
  attempt_count: 0,
  max_attempts: 3,
};

// ============================================================================
// create
// ============================================================================
describe('AIJobService.create', () => {
  it('creates a new AI job with defaults', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseJob] });

    const result = await AIJobService.create({ eventId: 'evt1', subsystem: 'onboarding' });
    expect(result.success).toBe(true);
    expect(result.data?.subsystem).toBe('onboarding');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_jobs'),
      expect.arrayContaining(['evt1', 'onboarding']),
    );
  });

  it('creates job with custom params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, model_provider: 'openai' }] });

    const result = await AIJobService.create({
      eventId: 'evt1',
      subsystem: 'scoper',
      modelProvider: 'openai',
      modelId: 'gpt-4o',
      promptVersion: '1.0.0',
      timeoutMs: 15000,
      maxAttempts: 5,
    });
    expect(result.success).toBe(true);
  });

  it('handles DB error on create', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert fail'));

    const result = await AIJobService.create({ eventId: 'evt1', subsystem: 'test' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ============================================================================
// start
// ============================================================================
describe('AIJobService.start', () => {
  it('starts processing a job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'PROCESSING' }] });

    const result = await AIJobService.start('job1');
    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('PROCESSING'),
      ['job1'],
    );
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.start('job_missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// complete
// ============================================================================
describe('AIJobService.complete', () => {
  it('completes a job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'COMPLETED' }] });

    const result = await AIJobService.complete('job1');
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.complete('job_missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// fail
// ============================================================================
describe('AIJobService.fail', () => {
  it('sets status to PENDING when retries remain', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, attempt_count: 1, max_attempts: 3 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'PENDING', last_error: 'timeout' }] });

    const result = await AIJobService.fail('job1', 'timeout');
    expect(result.success).toBe(true);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][0]).toBe('PENDING');
  });

  it('sets status to FAILED when max attempts reached', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, attempt_count: 3, max_attempts: 3 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'FAILED' }] });

    const result = await AIJobService.fail('job1', 'rate limited');
    expect(result.success).toBe(true);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][0]).toBe('FAILED');
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.fail('job_missing', 'err');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// timeout
// ============================================================================
describe('AIJobService.timeout', () => {
  it('marks job as timed out', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'TIMED_OUT' }] });

    const result = await AIJobService.timeout('job1');
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.timeout('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// kill
// ============================================================================
describe('AIJobService.kill', () => {
  it('kills a job (admin action)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseJob, status: 'KILLED' }] });

    const result = await AIJobService.kill('job1');
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.kill('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// getById
// ============================================================================
describe('AIJobService.getById', () => {
  it('returns job by ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseJob] });

    const result = await AIJobService.getById('job1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('job1');
  });

  it('returns NOT_FOUND for missing job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIJobService.getById('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIJobService.getById('job1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
