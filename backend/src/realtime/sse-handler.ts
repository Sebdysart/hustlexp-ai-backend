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
import { HTTPException } from 'hono/http-exception';
import { addConnection, teardownConnection, type SSEConnection } from './connection-registry.js';
import { firebaseAuth } from '../auth/firebase.js';
import { db } from '../db.js';
import type { User } from '../types.js';
import { logger } from '../logger.js';
import { 
  initializePubSub, 
  subscribeToRoom, 
  unsubscribeFromRoom,
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
    const decoded = await firebaseAuth.verifyIdToken(token, true);
    const result = await db.query<User>(
      'SELECT id, is_banned, account_status FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    const user = result.rows[0] || null;
    if (user && (user.is_banned || user.account_status === 'SUSPENDED' || user.account_status === 'DELETED')) {
      throw new HTTPException(403, { message: 'Account suspended' });
    }
    return user;
  } catch (err) {
    if (err instanceof HTTPException) throw err;
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

  const cleanupConnection = (
    reason: 'disconnect' | 'cancel' | 'initialization_error',
    controller?: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (!conn || conn.teardownComplete) return;
    teardownConnection(user.id, conn, controller !== undefined);

    log.info({ userId: user.id, reason }, 'SSE connection cleaned up');
  };

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
        conn.teardownComplete = true;
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
      const personalRoom = getUserRoomKey(user.id);
      try {
        subscribeToRoom(user.id, personalRoom);
        conn.releasePersonalRoom = () => unsubscribeFromRoom(user.id, personalRoom);
      } catch (subscriptionError) {
        log.error({ err: subscriptionError, userId: user.id }, 'Failed to acquire personal realtime room');
        cleanupConnection('initialization_error', controller);
        return;
      }

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
        cleanupConnection('initialization_error', controller);
      }

      // Handle client disconnect via request signal
      if (c.req.raw.signal) {
        const handleAbort = (): void => {
          cleanupConnection('disconnect', controller);
        };
        if (c.req.raw.signal.aborted) {
          handleAbort();
        } else {
          c.req.raw.signal.addEventListener('abort', handleAbort, { once: true });
        }
      }
    },
    cancel() {
      // Stream cancelled - remove connection and unsubscribe
      cleanupConnection('cancel');
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
