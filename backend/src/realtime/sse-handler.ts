/**
 * SSE Handler v1.0.0
 * 
 * Pillar A - Realtime Tracking: Server-Sent Events endpoint
 * 
 * Endpoint: GET /realtime/stream
 * 
 * Behavior:
 * - Authenticate user
 * - Register connection
 * - Keep open until disconnect
 * - No subscribe messages (connection == subscription)
 * 
 * @see Step 10 - Realtime Transport Implementation
 */

import { Context } from 'hono';
import { addConnection, removeConnection, type SSEConnection } from './connection-registry.js';
import { firebaseAuth } from '../auth/firebase.js';
import { db } from '../db.js';
import type { User } from '../types.js';
import { logger } from '../logger.js';
import { 
  initializePubSub, 
  subscribeToRoom, 
  unsubscribeAllRooms,
  getUserRoomKey 
} from './redis-pubsub.js';

const log = logger.child({ module: 'sse-handler' });

// Initialize Redis pub/sub on module load
try {
  initializePubSub();
} catch (err) {
  log.error({ err }, 'Failed to initialize Redis pub/sub');
}

/**
 * Helper to get authenticated user from Bearer token (matches server.ts pattern)
 */
async function getAuthUser(c: Context): Promise<User | null> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.slice(7);
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * SSE Handler - GET /realtime/stream
 * 
 * Returns a streaming response for Server-Sent Events
 */
export async function sseHandler(c: Context): Promise<Response> {
  // Authenticate user
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  log.info({ userId: user.id }, 'SSE connected');

  // Create connection object (controller will be set in stream start)
  let conn: SSEConnection | null = null;

  // Create ReadableStream for SSE
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Create connection object with controller
      conn = {
        userId: user.id,
        controller,
        closed: false,
      };

      // SECURITY: Register connection. addConnection() throws SSE_CONNECTION_LIMIT when the
      // per-user or reconnect-rate limit is exceeded. At this point the 200 response headers
      // have already been committed (the Response was constructed before this callback runs),
      // so we cannot return a 429. Instead: send an error event and close the stream
      // gracefully so the client receives a clean termination rather than an unhandled
      // exception crashing the process.
      try {
        addConnection(user.id, conn);
      } catch (limitErr) {
        conn.closed = true;
        log.warn({ userId: user.id, err: limitErr instanceof Error ? limitErr.message : String(limitErr) }, 'SSE connection limit reached; closing stream gracefully');
        const encoder = new TextEncoder();
        try {
          const errEvent = JSON.stringify({ type: 'error', code: 'CONNECTION_LIMIT', message: 'Too many concurrent connections' });
          controller.enqueue(encoder.encode(`data: ${errEvent}\n\n`));
        } catch {
          // Enqueue may already fail if controller was closed — safe to ignore
        }
        try {
          controller.close();
        } catch {
          // Already closed — safe to ignore
        }
        return;
      }

      // Subscribe to user's personal room (for direct messages)
      subscribeToRoom(user.id, getUserRoomKey(user.id));

      // Send initial connection message with connection ID
      const encoder = new TextEncoder();
      try {
        const initMessage = JSON.stringify({
          type: 'connected',
          userId: user.id,
          timestamp: new Date().toISOString(),
        });
        controller.enqueue(encoder.encode(`data: ${initMessage}\n\n`));
      } catch (_error) {
        // Controller already closed or error
        if (conn) {
          conn.closed = true;
          removeConnection(user.id, conn);
          unsubscribeAllRooms(user.id);
        }
      }

      // Handle client disconnect via request signal
      if (c.req.raw.signal) {
        c.req.raw.signal.addEventListener('abort', () => {
          if (conn) {
            conn.closed = true;
            removeConnection(user.id, conn);
            // Unsubscribe from all rooms on disconnect
            unsubscribeAllRooms(user.id);
            log.info({ userId: user.id }, 'SSE disconnected');
            try {
              controller.close();
            } catch (_error) {
              // Controller already closed
            }
          }
        });
      }
    },
    cancel() {
      // Stream cancelled - remove connection and unsubscribe
      if (conn) {
        conn.closed = true;
        removeConnection(user.id, conn);
        unsubscribeAllRooms(user.id);
        log.info({ userId: user.id }, 'SSE stream cancelled');
      }
    },
  });

  // Return streaming response with SSE headers
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
