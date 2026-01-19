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

import type { Context } from 'hono';

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
 * Add SSE connection to registry
 */
export function addConnection(userId: string, conn: SSEConnection): void {
  if (!connections.has(userId)) {
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
