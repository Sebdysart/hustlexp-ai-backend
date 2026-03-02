/**
 * requestId Middleware Unit Tests (TDD — RED phase)
 *
 * Tests for:
 *   addRequestId     — onRequest hook: generates / reuses request IDs
 *   returnRequestId  — onResponse hook: echoes ID back via X-Request-Id header
 *   logRequest       — onResponse hook: structured logging without throwing
 *   createGlobalErrorHandler — Fastify error handler factory
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// addRequestId
// ---------------------------------------------------------------------------

describe('addRequestId', () => {
  it('generates a req_<ULID> request ID when no x-request-id header provided', async () => {
    const { addRequestId } = await import('../middleware/requestId.js');

    const request = { headers: {}, requestId: undefined as string | undefined };
    const reply = { header: vi.fn().mockReturnThis() };

    await addRequestId(request as never, reply as never);

    expect((request as { requestId?: string }).requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('reuses x-request-id header when client provides one', async () => {
    const { addRequestId } = await import('../middleware/requestId.js');

    const clientId = 'client-provided-id-abc-123';
    const request = {
      headers: { 'x-request-id': clientId },
      requestId: undefined as string | undefined,
    };
    const reply = { header: vi.fn().mockReturnThis() };

    await addRequestId(request as never, reply as never);

    expect((request as { requestId?: string }).requestId).toBe(clientId);
  });

  it('generates a fresh ID when x-request-id header is empty string', async () => {
    const { addRequestId } = await import('../middleware/requestId.js');

    const request = { headers: { 'x-request-id': '' }, requestId: undefined as string | undefined };
    const reply = { header: vi.fn().mockReturnThis() };

    await addRequestId(request as never, reply as never);

    const id = (request as { requestId?: string }).requestId;
    expect(id).toMatch(/^req_/);
    expect(id).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// returnRequestId
// ---------------------------------------------------------------------------

describe('returnRequestId', () => {
  it('sets X-Request-Id response header from request.requestId', async () => {
    const { returnRequestId } = await import('../middleware/requestId.js');

    const request = { requestId: 'req_TESTULID01234567890123456' };
    const headerMock = vi.fn().mockReturnThis();
    const reply = { header: headerMock };

    await returnRequestId(request as never, reply as never);

    expect(headerMock).toHaveBeenCalledWith('X-Request-Id', 'req_TESTULID01234567890123456');
  });

  it('does not throw when requestId is undefined', async () => {
    const { returnRequestId } = await import('../middleware/requestId.js');

    const request = {};
    const reply = { header: vi.fn().mockReturnThis() };

    await expect(returnRequestId(request as never, reply as never)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// logRequest
// ---------------------------------------------------------------------------

describe('logRequest', () => {
  it('does not throw for a completed GET request', async () => {
    const { logRequest } = await import('../middleware/requestId.js');

    const request = {
      requestId: 'req_LOG123',
      method: 'GET',
      url: '/health',
      ip: '127.0.0.1',
    };
    const reply = { statusCode: 200 };

    await expect(logRequest(request as never, reply as never)).resolves.not.toThrow();
  });

  it('does not throw when requestId is absent', async () => {
    const { logRequest } = await import('../middleware/requestId.js');

    const request = { method: 'POST', url: '/api/tasks', ip: '10.0.0.1' };
    const reply = { statusCode: 201 };

    await expect(logRequest(request as never, reply as never)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createGlobalErrorHandler
// ---------------------------------------------------------------------------

describe('createGlobalErrorHandler', () => {
  it('returns a callable function', async () => {
    const { createGlobalErrorHandler } = await import('../middleware/requestId.js');
    const handler = createGlobalErrorHandler();
    expect(typeof handler).toBe('function');
  });

  it('sends 400 for errors with statusCode 400', async () => {
    const { createGlobalErrorHandler } = await import('../middleware/requestId.js');
    const handler = createGlobalErrorHandler();

    const statusMock = vi.fn().mockReturnThis();
    const sendMock = vi.fn().mockReturnThis();
    const reply = { status: statusMock, send: sendMock, code: vi.fn().mockReturnThis() };

    const error = Object.assign(new Error('Bad input'), { statusCode: 400 });
    handler(error as never, {} as never, reply as never);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(sendMock).toHaveBeenCalled();
  });

  it('sends 400 with validation details when error.validation is present', async () => {
    const { createGlobalErrorHandler } = await import('../middleware/requestId.js');
    const handler = createGlobalErrorHandler();

    const statusMock = vi.fn().mockReturnThis();
    const sendMock = vi.fn().mockReturnThis();
    const reply = { status: statusMock, send: sendMock, code: vi.fn().mockReturnThis() };

    const error = Object.assign(new Error('schema validation'), {
      statusCode: 400,
      validation: [{ message: 'body/field is required' }],
    });
    handler(error as never, {} as never, reply as never);

    expect(statusMock).toHaveBeenCalledWith(400);
    const payload = sendMock.mock.calls[0][0] as { code: string; details: unknown[] };
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(payload.details)).toBe(true);
  });

  it('sends 500 for errors with no statusCode', async () => {
    const { createGlobalErrorHandler } = await import('../middleware/requestId.js');
    const handler = createGlobalErrorHandler();

    const statusMock = vi.fn().mockReturnThis();
    const sendMock = vi.fn().mockReturnThis();
    const reply = { status: statusMock, send: sendMock, code: vi.fn().mockReturnThis() };

    const error = new Error('Something went wrong internally');
    handler(error as never, {} as never, reply as never);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(sendMock).toHaveBeenCalled();
  });
});
