/**
 * FIX-Y1 Bug 3: SSE addConnection limit — stream closes gracefully, no unhandled exception
 *
 * When addConnection() throws (per-user limit or reconnect flood), the SSE handler's
 * start() callback is already past headers-committed. The fix catches the error,
 * sends a typed error SSE event, and closes the stream — no exception propagates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// HOISTED MOCKS (required for variables referenced inside vi.mock factories)
// ============================================================================

const {
  mockVerifyIdToken,
  mockDbQuery,
  mockAddConnection,
  mockRemoveConnection,
  mockSubscribeToRoom,
  mockUnsubscribeAllRooms,
  mockGetUserRoomKey,
  mockInitializePubSub,
} = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
  mockDbQuery: vi.fn(),
  mockAddConnection: vi.fn(),
  mockRemoveConnection: vi.fn(),
  mockSubscribeToRoom: vi.fn(),
  mockUnsubscribeAllRooms: vi.fn(),
  mockGetUserRoomKey: vi.fn((userId: string) => `room:user:${userId}`),
  mockInitializePubSub: vi.fn(),
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: mockVerifyIdToken },
}));

vi.mock('../../src/db', () => ({
  db: { query: mockDbQuery },
}));

vi.mock('../../src/realtime/connection-registry', () => ({
  addConnection: mockAddConnection,
  removeConnection: mockRemoveConnection,
  getConnections: vi.fn().mockReturnValue(undefined),
  getAllConnections: vi.fn().mockReturnValue(new Map()),
}));

vi.mock('../../src/realtime/redis-pubsub', () => ({
  initializePubSub: mockInitializePubSub,
  subscribeToRoom: mockSubscribeToRoom,
  unsubscribeAllRooms: mockUnsubscribeAllRooms,
  getUserRoomKey: mockGetUserRoomKey,
  getTaskRoomKey: vi.fn((id: string) => `room:task:${id}`),
  publishToRoom: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToUser: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// ============================================================================
// IMPORTS (after vi.mock declarations)
// ============================================================================
import { sseHandler } from '../../src/realtime/sse-handler';

// ============================================================================
// HELPERS
// ============================================================================

const mockUser = { id: 'sse-user-limit-1', firebase_uid: 'firebase-uid-limit', email: 'limit@test.com' };

function makeSseContext(authHeader?: string, signal?: AbortSignal): any {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authHeader : undefined,
      raw: { signal: signal ?? null },
    },
    json: vi.fn((body: any, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 })
    ),
  };
}

/** Drain a ReadableStream to completion, collecting all text chunks. */
async function drainStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) text += decoder.decode(chunk.value);
  }
  return text;
}

function setupAuthSuccess() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: mockUser.firebase_uid });
  mockDbQuery.mockResolvedValueOnce({ rows: [mockUser] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInitializePubSub.mockImplementation(() => { /* no-op */ });
});

// ============================================================================
// TESTS
// ============================================================================

describe('Bug 3 – SSE addConnection limit closes stream gracefully, no unhandled exception', () => {

  it('resolves to a Response (does not throw) when addConnection throws', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementationOnce(() => {
      throw new Error('SSE_CONNECTION_LIMIT: User has reached max connections');
    });

    const ctx = makeSseContext('Bearer valid-token');

    // Must not throw
    await expect(sseHandler(ctx)).resolves.toBeInstanceOf(Response);
  });

  it('returns a streaming response even when addConnection throws', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementationOnce(() => {
      throw new Error('SSE_CONNECTION_LIMIT: User has reached max connections');
    });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);

    expect(response.body).toBeInstanceOf(ReadableStream);
  });

  it('sends a CONNECTION_LIMIT error event before closing when limit is hit', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementationOnce(() => {
      throw new Error('SSE_CONNECTION_LIMIT: User has reached max connections');
    });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);

    const text = await drainStream(response.body!);

    expect(text).toContain('"type":"error"');
    expect(text).toContain('CONNECTION_LIMIT');
  });

  it('stream closes (done=true) after the limit error event', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementationOnce(() => {
      throw new Error('SSE_CONNECTION_LIMIT: reconnect flood');
    });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);

    // drainStream reads until done — if the stream never closes this would hang.
    // Vitest has a default timeout that would fail the test if it hangs.
    const text = await drainStream(response.body!);
    expect(text.length).toBeGreaterThan(0);
  });

  it('does NOT call subscribeToRoom when addConnection throws', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementationOnce(() => {
      throw new Error('SSE_CONNECTION_LIMIT: reconnect flood');
    });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);
    await drainStream(response.body!);

    expect(mockSubscribeToRoom).not.toHaveBeenCalled();
  });

  it('successful connection still registers and subscribes normally', async () => {
    setupAuthSuccess();
    // addConnection succeeds (default mock returns undefined)
    mockAddConnection.mockImplementation(() => { /* success */ });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);

    // Read the initial 'connected' event to trigger start()
    const reader = response.body!.getReader();
    await reader.read();
    reader.cancel();

    expect(mockAddConnection).toHaveBeenCalledWith(
      mockUser.id,
      expect.objectContaining({ userId: mockUser.id })
    );
    expect(mockSubscribeToRoom).toHaveBeenCalledWith(
      mockUser.id,
      `room:user:${mockUser.id}`
    );
  });

  it('successful connection sends the "connected" event in the initial chunk', async () => {
    setupAuthSuccess();
    mockAddConnection.mockImplementation(() => { /* success */ });

    const ctx = makeSseContext('Bearer valid-token');
    const response = await sseHandler(ctx);

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();

    expect(value).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"connected"');
    expect(text).toContain(`"userId":"${mockUser.id}"`);
  });
});
