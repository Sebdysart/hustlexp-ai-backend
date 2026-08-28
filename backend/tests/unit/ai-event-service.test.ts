/**
 * AIEventService Unit Tests
 *
 * Tests create and getById, including payload hashing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { AIEventService } from '../../src/services/AIEventService';
import { db } from '../../src/db';
import { createHash } from 'crypto';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const baseEvent = {
  id: 'evt1',
  subsystem: 'onboarding',
  event_type: 'calibration_submitted',
  payload: { prompt: 'I want to do tasks' },
  schema_version: '1.0.0',
};

describe('AIEventService.create', () => {
  it('creates an event with payload hash', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseEvent] });

    const result = await AIEventService.create({
      subsystem: 'onboarding',
      eventType: 'calibration_submitted',
      actorUserId: 'u1',
      payload: { prompt: 'I want to do tasks' },
      schemaVersion: '1.0.0',
    });

    expect(result.success).toBe(true);
    // Verify the hash was computed and passed
    const callArgs = mockQuery.mock.calls[0][1];
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ prompt: 'I want to do tasks' }))
      .digest('hex');
    expect(callArgs[7]).toBe(expectedHash);
  });

  it('passes all optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseEvent] });

    await AIEventService.create({
      subsystem: 'dispute',
      eventType: 'dispute_opened',
      actorUserId: 'u1',
      subjectUserId: 'u2',
      taskId: 't1',
      disputeId: 'disp1',
      payload: { reason: 'quality' },
      schemaVersion: '2.0.0',
    });

    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs[0]).toBe('dispute');
    expect(callArgs[1]).toBe('dispute_opened');
    expect(callArgs[2]).toBe('u1');
    expect(callArgs[3]).toBe('u2');
    expect(callArgs[4]).toBe('t1');
    expect(callArgs[5]).toBe('disp1');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert fail'));

    const result = await AIEventService.create({
      subsystem: 'test',
      eventType: 'test_event',
      payload: {},
      schemaVersion: '1.0.0',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('correctly hashes empty payload', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseEvent] });

    await AIEventService.create({
      subsystem: 'test',
      eventType: 'empty',
      payload: {},
      schemaVersion: '1.0.0',
    });

    const expectedHash = createHash('sha256').update('{}').digest('hex');
    expect(mockQuery.mock.calls[0][1][7]).toBe(expectedHash);
  });
});

describe('AIEventService.getById', () => {
  it('returns event by ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseEvent] });

    const result = await AIEventService.getById('evt1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('evt1');
  });

  it('returns NOT_FOUND for missing event', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIEventService.getById('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIEventService.getById('evt1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
