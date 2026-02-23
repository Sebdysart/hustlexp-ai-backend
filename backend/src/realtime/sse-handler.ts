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
import { addConnection, removeConnection, type SSEConnection } from './connection-registry';
import { firebaseAuth } from '../auth/firebase';
import { db } from '../db';
import type { User } from '../types';
import { logger } from '../logger';
import { 
  initializePubSub, 
  subscribeToRoom, 
  unsubscribeAllRooms,
  getUserRoomKey 
} from './redis-pubsub';

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

      // Register connection
      addConnection(user.id, conn);
      
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
      } catch (error) {
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
            } catch (error) {
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
