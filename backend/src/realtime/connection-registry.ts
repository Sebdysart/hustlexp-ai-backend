/**
 * Connection Registry v1.0.0
 * 
 * Pillar A - Realtime Tracking: In-memory SSE connection management
 * 
 * Responsibility: Track open SSE connections per user
 * 
 * Hard rules:
 * - No global broadcast
 * - User-scoped only
 * - Memory-only (acceptable for MVP)
 * - No persistence
 * 
 * @see Step 10 - Realtime Transport Implementation
 */

// ============================================================================
// TYPES
// ============================================================================

export interface SSEConnection {
  userId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Track connection for cleanup
  closed: boolean;
}

// ============================================================================
// CONNECTION REGISTRY (In-Memory)
// ============================================================================

// Map: userId → Set<SSEConnection>
const connections = new Map<string, Set<SSEConnection>>();

/**
 * Maximum simultaneous SSE connections allowed per user.
 * Prevents connection-flood DoS: each connection allocates a ReadableStream
 * controller, a TCP socket, and a Redis pub/sub channel.
 */
export const MAX_CONNECTIONS_PER_USER = 5;

/**
 * Reconnect flood protection: track per-user connection timestamps (epoch ms).
 * Enforces a maximum of RECONNECT_LIMIT attempts within RECONNECT_WINDOW_MS.
 */
const reconnectTracker = new Map<string, number[]>();
const RECONNECT_LIMIT = 10;
const RECONNECT_WINDOW_MS = 60_000; // 60 seconds

/**
 * Add SSE connection to registry.
 * Throws SSE_CONNECTION_LIMIT if the user already has MAX_CONNECTIONS_PER_USER
 * active connections — caller (sse-handler) must catch and return 429.
 * Throws SSE_CONNECTION_LIMIT if the user has reconnected more than
 * RECONNECT_LIMIT times within RECONNECT_WINDOW_MS — caller must return 429.
 */
export function addConnection(userId: string, conn: SSEConnection): void {
  const existing = connections.get(userId);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
    throw new Error(
      `SSE_CONNECTION_LIMIT: User ${userId} has reached the maximum of ${MAX_CONNECTIONS_PER_USER} concurrent connections`
    );
  }

  // Reconnect flood check: count connection attempts within the sliding window
  const now = Date.now();
  const windowStart = now - RECONNECT_WINDOW_MS;
  const recentTimestamps = (reconnectTracker.get(userId) ?? []).filter(t => t > windowStart);
  if (recentTimestamps.length >= RECONNECT_LIMIT) {
    throw new Error(
      `SSE_CONNECTION_LIMIT: User ${userId} has exceeded the reconnect rate limit of ${RECONNECT_LIMIT} connections per ${RECONNECT_WINDOW_MS / 1000}s`
    );
  }
  // Record this connection attempt AFTER filtering expired entries.
  recentTimestamps.push(now);
  // Clean up Map entries whose window has fully expired to prevent unbounded growth.
  // Note: recentTimestamps always has ≥ 1 entry here (we just pushed), so the delete
  // branch is intentionally absent — the set always gets written back.
  reconnectTracker.set(userId, recentTimestamps);

  // Periodically sweep expired entries from OTHER users (~1% of calls = roughly every 100 connections).
  // Running on every call would be O(n) per connection; the probabilistic approach amortises the cost.
  if (Math.random() < 0.01) {
    const windowStart = Date.now() - RECONNECT_WINDOW_MS;
    for (const [uid, timestamps] of reconnectTracker.entries()) {
      if (timestamps.filter((t: number) => t > windowStart).length === 0) {
        reconnectTracker.delete(uid);
      }
    }
  }

  if (!existing) {
    connections.set(userId, new Set());
  }
  connections.get(userId)!.add(conn);
}

/**
 * Remove SSE connection from registry
 */
export function removeConnection(userId: string, conn: SSEConnection): void {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) {
    connections.delete(userId);
  }
}

/**
 * Get all active connections for a user
 */
export function getConnections(userId: string): Set<SSEConnection> | undefined {
  return connections.get(userId);
}

/**
 * Get the full connections map (for broadcast operations)
 */
export function getAllConnections(): Map<string, Set<SSEConnection>> {
  return connections;
}

/**
 * Get connection count (for observability)
 */
export function getConnectionCount(userId?: string): number {
  if (userId) {
    return connections.get(userId)?.size || 0;
  }
  // Total connections across all users
  let total = 0;
  for (const set of connections.values()) {
    total += set.size;
  }
  return total;
}

/**
 * Clear the reconnect tracker for a given user (or all users).
 * Intended for use in tests to reset state between test cases.
 */
export function clearReconnectTracker(userId?: string): void {
  if (userId) {
    reconnectTracker.delete(userId);
  } else {
    reconnectTracker.clear();
  }
}

/**
 * Force-close all SSE connections for a user (e.g. after a ban).
 *
 * Closes every ReadableStreamDefaultController for the user, marks each
 * connection as closed, and removes the user from the registry entirely.
 * The client will receive a stream end and can attempt to reconnect — at
 * which point the banned-user check in the auth layer will reject them.
 */
export function forceDisconnectUser(userId: string): void {
  const set = connections.get(userId);
  if (!set) return;

  for (const conn of set) {
    conn.closed = true;
    try {
      conn.controller.close();
    } catch {
      // Controller may already be closed — safe to ignore
    }
  }

  connections.delete(userId);
  // Do NOT clear reconnectTracker here. Wiping the tracker on a forced
  // disconnect (e.g. after a ban) would give the banned user a fresh flood
  // budget immediately, allowing them to hammer the SSE endpoint before auth
  // rejection kicks in. The tracker entries expire naturally via the sliding-
  // window filter in addConnection, so unbounded growth is not a concern.
}
