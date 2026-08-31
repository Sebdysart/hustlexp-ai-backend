import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockRedisInstance = {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  messageHandler?: (channel: string, message: string) => void;
};

const {
  mockRedisInstances,
  mockDbQuery,
  mockCanReceiveProgressEvent,
  mockGetConnections,
} = vi.hoisted(() => ({
  mockRedisInstances: [] as MockRedisInstance[],
  mockDbQuery: vi.fn(),
  mockCanReceiveProgressEvent: vi.fn(),
  mockGetConnections: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = vi.fn().mockResolvedValue(1);
    subscribe = vi.fn().mockResolvedValue(1);
    unsubscribe = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    messageHandler?: (channel: string, message: string) => void;

    constructor() {
      mockRedisInstances.push(this as unknown as MockRedisInstance);
    }

    on(event: string, handler: (channel: string, message: string) => void): void {
      if (event === 'message') this.messageHandler = handler;
    }
  },
}));

vi.mock('../../src/config', () => ({
  config: { redis: { url: 'redis://shared-nonprod:6379' } },
}));

vi.mock('../../src/db', () => ({ db: { query: mockDbQuery } }));

vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canReceiveProgressEvent: (...args: unknown[]) => mockCanReceiveProgressEvent(...args),
  },
}));

vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: (...args: unknown[]) => mockGetConnections(...args),
  getAllConnections: vi.fn(() => new Map()),
  forceDisconnectUser: vi.fn(),
  teardownConnection: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
  },
}));

import { processRealtimeJob } from '../../src/jobs/realtime-worker';
import {
  getRoomSubscribers,
  getTaskRoomKey,
  getUserRoomKey,
  initializePubSub,
  shutdownPubSub,
  subscribeToRoom,
  subscribeToTask,
  unsubscribeFromRoom,
} from '../../src/realtime/redis-pubsub';

describe('realtime worker cross-instance delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstances.length = 0;
    mockCanReceiveProgressEvent.mockResolvedValue(true);
    mockGetConnections.mockReturnValue(undefined);
  });

  afterEach(async () => {
    await shutdownPubSub().catch(() => undefined);
  });

  it('publishes worker events to canonical personal rooms for one API-side enqueue each', async () => {
    const posterId = 'poster-cross-instance';
    const workerId = 'worker-cross-instance';
    const posterRoom = getUserRoomKey(posterId);
    const workerRoom = getUserRoomKey(workerId);
    const posterEnqueue = vi.fn();
    const workerEnqueue = vi.fn();

    subscribeToRoom(posterId, posterRoom);
    subscribeToRoom(workerId, workerRoom);
    initializePubSub();
    await Promise.resolve();

    mockGetConnections.mockImplementation((userId: string) => {
      if (userId === posterId) {
        return new Set([{
          userId: posterId,
          closed: false,
          controller: { enqueue: posterEnqueue },
        }]);
      }
      if (userId === workerId) {
        return new Set([{
          userId: workerId,
          closed: false,
          controller: { enqueue: workerEnqueue },
        }]);
      }
      return undefined;
    });

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ poster_id: posterId, worker_id: workerId, risk_level: 'low' }],
      })
      .mockResolvedValueOnce({ rows: [{ is_banned: false }] })
      .mockResolvedValueOnce({ rows: [{ is_banned: false }] });

    const occurredAt = '2026-08-28T12:34:56.789Z';
    const job = {
      data: {
        aggregate_type: 'task',
        aggregate_id: 'task-cross-instance',
        event_version: 7,
        payload: {
          taskId: 'task-cross-instance',
          from: 'TRAVELING',
          to: 'WORKING',
          actor: { type: 'worker', userId: workerId },
          occurredAt,
        },
      },
    } as Job;

    // This represents the dedicated worker process. Publishing itself must not
    // touch either API instance's process-local connection registry.
    await processRealtimeJob(job);
    expect(posterEnqueue).not.toHaveBeenCalled();
    expect(workerEnqueue).not.toHaveBeenCalled();

    const publisher = mockRedisInstances.find(instance => instance.publish.mock.calls.length > 0);
    const apiSubscriber = mockRedisInstances.find(instance => instance.messageHandler);
    expect(publisher?.publish).toHaveBeenCalledTimes(2);
    expect(apiSubscriber?.messageHandler).toBeDefined();

    // Shared Redis delivers each publication to the API instance subscribed
    // to the corresponding personal room.
    for (const [channel, rawEnvelope] of publisher!.publish.mock.calls) {
      expect([posterRoom, workerRoom]).toContain(channel);
      const envelope = JSON.parse(rawEnvelope as string);
      expect(envelope).toEqual({
        schemaVersion: 1,
        type: 'task.progress_updated',
        payload: job.data.payload,
        timestamp: occurredAt,
        room: channel,
      });
      apiSubscriber!.messageHandler!(channel as string, rawEnvelope as string);
    }

    expect(posterEnqueue).toHaveBeenCalledOnce();
    expect(workerEnqueue).toHaveBeenCalledOnce();
    expect(getRoomSubscribers(getTaskRoomKey('task-cross-instance'))).toBeUndefined();
    expect(() => subscribeToTask(posterId, 'task-cross-instance')).toThrow('SSE_TASK_ROOMS_DISABLED');

    unsubscribeFromRoom(posterId, posterRoom);
    unsubscribeFromRoom(workerId, workerRoom);
  });
});
