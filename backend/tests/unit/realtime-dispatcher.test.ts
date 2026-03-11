import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

const mockGetConnections = vi.fn();
const mockGetAllConnections = vi.fn();
vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: (...args: unknown[]) => mockGetConnections(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
}));

const mockCanReceiveProgressEvent = vi.fn();
vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canReceiveProgressEvent: (...args: unknown[]) => mockCanReceiveProgressEvent(...args),
  },
}));

import { db } from '../../src/db';
import {
  dispatchTaskProgress,
  dispatchNewMessage,
  dispatchFlagChanged,
} from '../../src/realtime/realtime-dispatcher';

function createMockEvent(overrides = {}) {
  return {
    event_type: 'task.progress_updated',
    aggregate_type: 'task',
    aggregate_id: 'task-123',
    payload: {
      taskId: 'task-123',
      from: 'assigned',
      to: 'in_progress',
      actor: { type: 'worker' as const, userId: 'worker-1' },
      occurredAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function createMockConn(closed = false) {
  const enqueueFn = vi.fn();
  return {
    userId: 'test',
    controller: { enqueue: enqueueFn },
    closed,
    _enqueue: enqueueFn,
  };
}

describe('Realtime Dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnections.mockReturnValue(undefined);
    mockGetAllConnections.mockReturnValue(new Map());
    mockCanReceiveProgressEvent.mockResolvedValue(true);
  });

  // ===========================================================================
  // dispatchTaskProgress
  // ===========================================================================
  describe('dispatchTaskProgress', () => {
    it('throws for non-task.progress_updated events', async () => {
      const event = createMockEvent({ event_type: 'other.event' });
      await expect(dispatchTaskProgress(event)).rejects.toThrow('Unexpected event type');
    });

    it('skips when task not found in DB', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

      const event = createMockEvent();
      // Should not throw, just returns
      await expect(dispatchTaskProgress(event)).resolves.toBeUndefined();
    });

    it('sends to poster and worker when both are connected', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: 'worker-1', risk_level: 'low' }],
      });

      const posterConn = createMockConn();
      const workerConn = createMockConn();

      mockGetConnections.mockImplementation((userId: string) => {
        if (userId === 'poster-1') return new Set([posterConn]);
        if (userId === 'worker-1') return new Set([workerConn]);
        return undefined;
      });

      await dispatchTaskProgress(createMockEvent());

      expect(posterConn._enqueue).toHaveBeenCalled();
      expect(workerConn._enqueue).toHaveBeenCalled();
    });

    it('skips users without active connections', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });

      mockGetConnections.mockReturnValue(undefined);

      await expect(dispatchTaskProgress(createMockEvent())).resolves.toBeUndefined();
    });

    it('skips closed connections', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });

      const closedConn = createMockConn(true);
      mockGetConnections.mockReturnValue(new Set([closedConn]));

      await dispatchTaskProgress(createMockEvent());
      expect(closedConn._enqueue).not.toHaveBeenCalled();
    });

    it('marks connection as closed on write error', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });

      const badConn = {
        userId: 'poster-1',
        controller: { enqueue: vi.fn().mockImplementation(() => { throw new Error('write error'); }) },
        closed: false,
      };
      mockGetConnections.mockReturnValue(new Set([badConn]));

      await dispatchTaskProgress(createMockEvent());
      expect(badConn.closed).toBe(true);
    });

    it('respects PlanService filtering', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });

      mockCanReceiveProgressEvent.mockResolvedValue(false);

      const posterConn = createMockConn();
      mockGetConnections.mockReturnValue(new Set([posterConn]));

      await dispatchTaskProgress(createMockEvent());
      // Poster was filtered out by PlanService
      expect(posterConn._enqueue).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // dispatchNewMessage
  // ===========================================================================
  describe('dispatchNewMessage', () => {
    it('sends message to recipient connections', async () => {
      const conn = createMockConn();
      mockGetConnections.mockReturnValue(new Set([conn]));

      await dispatchNewMessage({
        messageId: 'msg-1',
        taskId: 'task-1',
        senderId: 'sender-1',
        recipientId: 'recipient-1',
        content: 'Hello',
        createdAt: new Date().toISOString(),
      });

      expect(conn._enqueue).toHaveBeenCalled();
    });

    it('does nothing when recipient has no connections', async () => {
      mockGetConnections.mockReturnValue(undefined);

      await expect(
        dispatchNewMessage({
          messageId: 'msg-2',
          taskId: 'task-2',
          senderId: 'sender-2',
          recipientId: 'nobody',
          createdAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    });

    it('skips closed connections', async () => {
      const conn = createMockConn(true);
      mockGetConnections.mockReturnValue(new Set([conn]));

      await dispatchNewMessage({
        messageId: 'msg-3',
        taskId: 'task-3',
        senderId: 's3',
        recipientId: 'r3',
        createdAt: new Date().toISOString(),
      });

      expect(conn._enqueue).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // dispatchFlagChanged
  // ===========================================================================
  describe('dispatchFlagChanged', () => {
    it('broadcasts to all active connections', async () => {
      const conn1 = createMockConn();
      const conn2 = createMockConn();

      mockGetAllConnections.mockReturnValue(
        new Map([
          ['user1', new Set([conn1])],
          ['user2', new Set([conn2])],
        ]),
      );

      await dispatchFlagChanged('feature_x');

      expect(conn1._enqueue).toHaveBeenCalled();
      expect(conn2._enqueue).toHaveBeenCalled();
    });

    it('does nothing when no connections exist', async () => {
      mockGetAllConnections.mockReturnValue(new Map());

      await expect(dispatchFlagChanged('empty_flag')).resolves.toBeUndefined();
    });

    it('skips closed connections in broadcast', async () => {
      const openConn = createMockConn(false);
      const closedConn = createMockConn(true);

      mockGetAllConnections.mockReturnValue(
        new Map([['user1', new Set([openConn, closedConn])]]),
      );

      await dispatchFlagChanged('test_flag');

      expect(openConn._enqueue).toHaveBeenCalled();
      expect(closedConn._enqueue).not.toHaveBeenCalled();
    });
  });
});
