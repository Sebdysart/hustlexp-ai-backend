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

  console.log(`🔌 SSE connected: userId=${user.id}`);

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

      // Send initial connection message (optional - helps client know connection is live)
      const encoder = new TextEncoder();
      try {
        controller.enqueue(encoder.encode(': connected\n\n'));
      } catch (error) {
        // Controller already closed or error
        if (conn) {
          conn.closed = true;
          removeConnection(user.id, conn);
        }
      }

      // Handle client disconnect via request signal
      if (c.req.raw.signal) {
        c.req.raw.signal.addEventListener('abort', () => {
          if (conn) {
            conn.closed = true;
            removeConnection(user.id, conn);
            console.log(`🔌 SSE disconnected: userId=${user.id}`);
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
      // Stream cancelled - remove connection
      if (conn) {
        conn.closed = true;
        removeConnection(user.id, conn);
        console.log(`🔌 SSE stream cancelled: userId=${user.id}`);
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
