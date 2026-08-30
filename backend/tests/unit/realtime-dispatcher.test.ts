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
const mockForceDisconnectUser = vi.fn();
const mockTeardownConnection = vi.fn();
vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: (...args: unknown[]) => mockGetConnections(...args),
  getAllConnections: (...args: unknown[]) => mockGetAllConnections(...args),
  forceDisconnectUser: (...args: unknown[]) => mockForceDisconnectUser(...args),
  teardownConnection: (...args: unknown[]) => mockTeardownConnection(...args),
}));

const mockPublishUserRealtimeEvent = vi.fn();
vi.mock('../../src/realtime/redis-pubsub', () => ({
  publishUserRealtimeEvent: (...args: unknown[]) => mockPublishUserRealtimeEvent(...args),
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

/** Return a not-banned DB row for the ban-check query */
function mockNotBanned() {
  (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ is_banned: false }] });
}

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
    mockPublishUserRealtimeEvent.mockResolvedValue(undefined);
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

    it('publishes canonical personal events for poster and worker', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: 'worker-1', risk_level: 'low' }],
      });
      // ban check: poster not banned, worker not banned
      mockNotBanned();
      mockNotBanned();

      const event = createMockEvent();
      await dispatchTaskProgress(event);

      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledTimes(2);
      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledWith(
        'poster-1',
        'task.progress_updated',
        event.payload,
        event.payload.occurredAt,
      );
      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledWith(
        'worker-1',
        'task.progress_updated',
        event.payload,
        event.payload.occurredAt,
      );
    });

    it('publishes without relying on process-local worker connections', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });
      // ban check: poster not banned
      mockNotBanned();

      mockGetConnections.mockReturnValue(undefined);

      await expect(dispatchTaskProgress(createMockEvent())).resolves.toBeUndefined();
      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledOnce();
      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledWith(
        'poster-1',
        'task.progress_updated',
        expect.objectContaining({ taskId: 'task-123' }),
        expect.any(String),
      );
    });

    it('does not consult stale process-local connections before Redis publication', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });
      // ban check: poster not banned
      mockNotBanned();

      const closedConn = createMockConn(true);
      mockGetConnections.mockReturnValue(new Set([closedConn]));

      await dispatchTaskProgress(createMockEvent());
      expect(closedConn._enqueue).not.toHaveBeenCalled();
      expect(mockPublishUserRealtimeEvent).toHaveBeenCalledOnce();
    });

    it('propagates Redis publication failure so the worker job does not report success', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });
      // ban check: poster not banned
      mockNotBanned();

      mockPublishUserRealtimeEvent.mockRejectedValueOnce(new Error('Redis publish failed'));

      await expect(dispatchTaskProgress(createMockEvent())).rejects.toThrow('Redis publish failed');
    });

    it('respects PlanService filtering', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, risk_level: 'low' }],
      });

      mockCanReceiveProgressEvent.mockResolvedValue(false);

      const posterConn = createMockConn();
      mockGetConnections.mockReturnValue(new Set([posterConn]));

      await dispatchTaskProgress(createMockEvent());
      // Poster was filtered out by PlanService (ban check is not reached when PlanService returns false)
      expect(posterConn._enqueue).not.toHaveBeenCalled();
      expect(mockPublishUserRealtimeEvent).not.toHaveBeenCalled();
    });

    it('skips banned users and does not write to their connections', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-banned', worker_id: null, risk_level: 'low' }],
      });
      // ban check: poster IS banned
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ is_banned: true }] });

      const posterConn = createMockConn();
      mockGetConnections.mockReturnValue(new Set([posterConn]));

      await dispatchTaskProgress(createMockEvent());

      // forceDisconnectUser called and no enqueue sent
      expect(mockForceDisconnectUser).toHaveBeenCalledWith('poster-banned');
      expect(posterConn._enqueue).not.toHaveBeenCalled();
      expect(mockPublishUserRealtimeEvent).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // dispatchNewMessage
  // ===========================================================================
  describe('dispatchNewMessage', () => {
    it('sends message to recipient connections', async () => {
      // ban check: recipient not banned
      mockNotBanned();

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
      // ban check: recipient not banned
      mockNotBanned();

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
      // ban check: recipient not banned
      mockNotBanned();

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

    it('does not deliver to a banned recipient and force-disconnects them', async () => {
      // ban check: recipient IS banned
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ is_banned: true }] });

      const conn = createMockConn();
      mockGetConnections.mockReturnValue(new Set([conn]));

      await dispatchNewMessage({
        messageId: 'msg-4',
        taskId: 'task-4',
        senderId: 's4',
        recipientId: 'banned-recipient',
        createdAt: new Date().toISOString(),
      });

      expect(mockForceDisconnectUser).toHaveBeenCalledWith('banned-recipient');
      expect(conn._enqueue).not.toHaveBeenCalled();
    });

    it('tears down the exact connection when enqueue fails', async () => {
      mockNotBanned();
      const enqueueError = new Error('controller closed');
      const conn = {
        userId: 'recipient-failed',
        controller: { enqueue: vi.fn(() => { throw enqueueError; }) },
        closed: false,
      };
      mockGetConnections.mockReturnValue(new Set([conn]));

      await dispatchNewMessage({
        messageId: 'msg-failed',
        taskId: 'task-failed',
        senderId: 'sender-failed',
        recipientId: 'recipient-failed',
        createdAt: new Date().toISOString(),
      });

      expect(mockTeardownConnection).toHaveBeenCalledOnce();
      expect(mockTeardownConnection).toHaveBeenCalledWith('recipient-failed', conn);
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
