import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addConnection,
  removeConnection,
  getConnections,
  getAllConnections,
  getConnectionCount,
  forceDisconnectUser,
  clearReconnectTracker,
  MAX_CONNECTIONS_PER_USER,
  type SSEConnection,
} from '../../src/realtime/connection-registry';

function createMockConnection(userId: string): SSEConnection {
  return {
    userId,
    controller: {
      enqueue: () => {},
      close: () => {},
      desiredSize: 1,
      error: () => {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
    closed: false,
  };
}

describe('Connection Registry', () => {
  beforeEach(() => {
    // Clean connections registry
    const all = getAllConnections();
    for (const [userId, conns] of all) {
      for (const conn of conns) {
        removeConnection(userId, conn);
      }
    }
    // Clean reconnect tracker so flood tests don't bleed into each other
    clearReconnectTracker();
  });

  // ===========================================================================
  // addConnection
  // ===========================================================================
  describe('addConnection', () => {
    it('adds a connection for a user', () => {
      const conn = createMockConnection('user1');
      addConnection('user1', conn);

      const conns = getConnections('user1');
      expect(conns).toBeDefined();
      expect(conns!.size).toBe(1);
      expect(conns!.has(conn)).toBe(true);
    });

    it('supports multiple connections per user', () => {
      const conn1 = createMockConnection('user2');
      const conn2 = createMockConnection('user2');
      addConnection('user2', conn1);
      addConnection('user2', conn2);

      const conns = getConnections('user2');
      expect(conns!.size).toBe(2);
    });

    it('creates separate sets for different users', () => {
      const connA = createMockConnection('userA');
      const connB = createMockConnection('userB');
      addConnection('userA', connA);
      addConnection('userB', connB);

      expect(getConnections('userA')!.size).toBe(1);
      expect(getConnections('userB')!.size).toBe(1);
    });
  });

  // ===========================================================================
  // removeConnection
  // ===========================================================================
  describe('removeConnection', () => {
    it('removes a specific connection', () => {
      const conn = createMockConnection('user3');
      addConnection('user3', conn);
      removeConnection('user3', conn);

      expect(getConnections('user3')).toBeUndefined();
    });

    it('deletes the user entry when last connection is removed', () => {
      const conn = createMockConnection('user4');
      addConnection('user4', conn);
      removeConnection('user4', conn);

      expect(getConnections('user4')).toBeUndefined();
    });

    it('keeps other connections when removing one', () => {
      const conn1 = createMockConnection('user5');
      const conn2 = createMockConnection('user5');
      addConnection('user5', conn1);
      addConnection('user5', conn2);
      removeConnection('user5', conn1);

      const conns = getConnections('user5');
      expect(conns!.size).toBe(1);
      expect(conns!.has(conn2)).toBe(true);
    });

    it('handles removing from non-existent user gracefully', () => {
      const conn = createMockConnection('ghost');
      expect(() => removeConnection('ghost', conn)).not.toThrow();
    });
  });

  // ===========================================================================
  // getConnections
  // ===========================================================================
  describe('getConnections', () => {
    it('returns undefined for user with no connections', () => {
      expect(getConnections('nonexistent')).toBeUndefined();
    });

    it('returns the Set of connections for a user', () => {
      const conn = createMockConnection('user6');
      addConnection('user6', conn);

      const conns = getConnections('user6');
      expect(conns).toBeInstanceOf(Set);
      expect(conns!.has(conn)).toBe(true);
    });
  });

  // ===========================================================================
  // getAllConnections
  // ===========================================================================
  describe('getAllConnections', () => {
    it('returns empty map when no connections exist', () => {
      const all = getAllConnections();
      expect(all.size).toBe(0);
    });

    it('returns all connections', () => {
      addConnection('u1', createMockConnection('u1'));
      addConnection('u2', createMockConnection('u2'));

      const all = getAllConnections();
      expect(all.size).toBe(2);
      expect(all.has('u1')).toBe(true);
      expect(all.has('u2')).toBe(true);
    });
  });

  // ===========================================================================
  // getConnectionCount
  // ===========================================================================
  describe('getConnectionCount', () => {
    it('returns 0 when no connections', () => {
      expect(getConnectionCount()).toBe(0);
    });

    it('returns total connections across all users', () => {
      addConnection('cx1', createMockConnection('cx1'));
      addConnection('cx1', createMockConnection('cx1'));
      addConnection('cx2', createMockConnection('cx2'));

      expect(getConnectionCount()).toBe(3);
    });

    it('returns connections for specific user', () => {
      addConnection('cy1', createMockConnection('cy1'));
      addConnection('cy1', createMockConnection('cy1'));
      addConnection('cy2', createMockConnection('cy2'));

      expect(getConnectionCount('cy1')).toBe(2);
      expect(getConnectionCount('cy2')).toBe(1);
    });

    it('returns 0 for user with no connections', () => {
      expect(getConnectionCount('nobody')).toBe(0);
    });
  });

  // ===========================================================================
  // forceDisconnectUser — Bug 1 fix
  // ===========================================================================
  describe('forceDisconnectUser', () => {
    it('closes all controllers for a user and removes them from the registry', () => {
      const closeSpy1 = vi.fn();
      const closeSpy2 = vi.fn();

      const conn1: SSEConnection = {
        userId: 'ban-user',
        controller: { enqueue: vi.fn(), close: closeSpy1, desiredSize: 1, error: vi.fn() } as unknown as ReadableStreamDefaultController<Uint8Array>,
        closed: false,
      };
      const conn2: SSEConnection = {
        userId: 'ban-user',
        controller: { enqueue: vi.fn(), close: closeSpy2, desiredSize: 1, error: vi.fn() } as unknown as ReadableStreamDefaultController<Uint8Array>,
        closed: false,
      };

      addConnection('ban-user', conn1);
      addConnection('ban-user', conn2);

      forceDisconnectUser('ban-user');

      expect(conn1.closed).toBe(true);
      expect(conn2.closed).toBe(true);
      expect(closeSpy1).toHaveBeenCalledOnce();
      expect(closeSpy2).toHaveBeenCalledOnce();
      expect(getConnections('ban-user')).toBeUndefined();
    });

    it('is a no-op when the user has no connections', () => {
      expect(() => forceDisconnectUser('no-such-user')).not.toThrow();
    });

    it('does not affect other users connections', () => {
      const connA = createMockConnection('userA-force');
      const connB = createMockConnection('userB-force');
      addConnection('userA-force', connA);
      addConnection('userB-force', connB);

      forceDisconnectUser('userA-force');

      expect(getConnections('userA-force')).toBeUndefined();
      expect(getConnections('userB-force')?.size).toBe(1);
    });

    it('swallows errors thrown by controller.close()', () => {
      const conn: SSEConnection = {
        userId: 'close-throws',
        controller: {
          enqueue: vi.fn(),
          close: vi.fn(() => { throw new Error('already closed'); }),
          desiredSize: 1,
          error: vi.fn(),
        } as unknown as ReadableStreamDefaultController<Uint8Array>,
        closed: false,
      };
      addConnection('close-throws', conn);
      expect(() => forceDisconnectUser('close-throws')).not.toThrow();
    });
  });

  // ===========================================================================
  // Reconnect flood guard — Bug 2 fix
  // ===========================================================================
  describe('reconnect flood guard', () => {
    it('allows up to 10 connections within 60 seconds', () => {
      for (let i = 0; i < 10; i++) {
        expect(() => addConnection('flood-user', createMockConnection('flood-user'))).not.toThrow();
        // Remove after adding so MAX_CONNECTIONS_PER_USER is not hit
        const conns = getConnections('flood-user');
        if (conns) {
          for (const c of conns) removeConnection('flood-user', c);
        }
      }
    });

    it('throws SSE_CONNECTION_LIMIT on the 11th reconnect within 60 seconds', () => {
      for (let i = 0; i < 10; i++) {
        const conn = createMockConnection('flood-user2');
        addConnection('flood-user2', conn);
        removeConnection('flood-user2', conn);
      }

      expect(() => addConnection('flood-user2', createMockConnection('flood-user2'))).toThrowError(
        /SSE_CONNECTION_LIMIT/
      );
    });

    it('allows reconnection again after the 60-second window has passed', () => {
      // Simulate timestamps older than 60 seconds by manipulating Date.now via vi.useFakeTimers
      vi.useFakeTimers();

      const userId = 'flood-window-user';
      for (let i = 0; i < 10; i++) {
        const conn = createMockConnection(userId);
        addConnection(userId, conn);
        removeConnection(userId, conn);
      }

      // Advance time by 61 seconds — all previous timestamps fall outside the window
      vi.advanceTimersByTime(61_000);

      expect(() => addConnection(userId, createMockConnection(userId))).not.toThrow();

      vi.useRealTimers();
    });

    it('does not share flood counters across different users', () => {
      for (let i = 0; i < 10; i++) {
        const conn = createMockConnection('flood-a');
        addConnection('flood-a', conn);
        removeConnection('flood-a', conn);
      }

      // flood-b is unaffected — should still be allowed
      expect(() => addConnection('flood-b', createMockConnection('flood-b'))).not.toThrow();
    });
  });
});
