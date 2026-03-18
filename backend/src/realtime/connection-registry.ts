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
 * Add SSE connection to registry.
 * Throws SSE_CONNECTION_LIMIT if the user already has MAX_CONNECTIONS_PER_USER
 * active connections — caller (sse-handler) must catch and return 429.
 */
export function addConnection(userId: string, conn: SSEConnection): void {
  const existing = connections.get(userId);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
    throw new Error(
      `SSE_CONNECTION_LIMIT: User ${userId} has reached the maximum of ${MAX_CONNECTIONS_PER_USER} concurrent connections`
    );
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
