import { describe, it, expect, beforeEach } from 'vitest';
import {
  addConnection,
  removeConnection,
  getConnections,
  getAllConnections,
  getConnectionCount,
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
    // Clean registry by getting all connections and removing them
    const all = getAllConnections();
    for (const [userId, conns] of all) {
      for (const conn of conns) {
        removeConnection(userId, conn);
      }
    }
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
});
