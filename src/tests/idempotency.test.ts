/**
 * idempotency Middleware Unit Tests (TDD — RED phase)
 *
 * Tests for:
 *   requireIdempotencyKey    — onRequest guard: rejects POSTs without Idempotency-Key header
 *   cacheIdempotentResponse  — onSend hook: stores response payload for repeated requests
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// requireIdempotencyKey
// ---------------------------------------------------------------------------

describe('requireIdempotencyKey', () => {
  it('calls reply.code(400).send() when Idempotency-Key header is absent', async () => {
    const { requireIdempotencyKey } = await import('../middleware/idempotency.js');

    const request = { headers: {}, method: 'POST', url: '/api/escrow/hold' };
    const codeMock = vi.fn().mockReturnThis();
    const sendMock = vi.fn();
    const reply = { code: codeMock, send: sendMock, sent: false };

    await requireIdempotencyKey(request as never, reply as never);

    expect(codeMock).toHaveBeenCalledWith(400);
    expect(sendMock).toHaveBeenCalled();

    // Payload should include a meaningful error code
    const payload = sendMock.mock.calls[0][0] as { error: string; code: string };
    expect(payload.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('does not reject when Idempotency-Key header is present', async () => {
    const { requireIdempotencyKey } = await import('../middleware/idempotency.js');

    const request = {
      headers: { 'idempotency-key': 'idem-key-abc-123' },
      method: 'POST',
      url: '/api/escrow/hold',
    };
    const codeMock = vi.fn().mockReturnThis();
    const sendMock = vi.fn();
    const reply = { code: codeMock, send: sendMock, sent: false };

    await requireIdempotencyKey(request as never, reply as never);

    expect(codeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not reject when Idempotency-Key is present (case-insensitive header access)', async () => {
    const { requireIdempotencyKey } = await import('../middleware/idempotency.js');

    // Fastify normalises headers to lowercase — test the lowercase variant
    const request = {
      headers: { 'idempotency-key': 'abc-key-123' },
      method: 'POST',
      url: '/api/tasks',
    };
    const codeMock = vi.fn().mockReturnThis();
    const reply = { code: codeMock, send: vi.fn(), sent: false };

    await requireIdempotencyKey(request as never, reply as never);

    expect(codeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cacheIdempotentResponse
// ---------------------------------------------------------------------------

describe('cacheIdempotentResponse', () => {
  it('does not throw when Idempotency-Key header is present', async () => {
    const { cacheIdempotentResponse } = await import('../middleware/idempotency.js');

    const request = {
      headers: { 'idempotency-key': 'key-xyz-789' },
      method: 'POST',
      url: '/api/escrow/hold',
    };
    const reply = { statusCode: 201 };

    await expect(
      cacheIdempotentResponse(request as never, reply as never, '{"escrowId":"esc_123"}')
    ).resolves.not.toThrow();
  });

  it('does not throw when no Idempotency-Key header is set', async () => {
    const { cacheIdempotentResponse } = await import('../middleware/idempotency.js');

    const request = { headers: {}, method: 'GET', url: '/api/tasks' };
    const reply = { statusCode: 200 };

    await expect(
      cacheIdempotentResponse(request as never, reply as never, '{"tasks":[]}')
    ).resolves.not.toThrow();
  });

  it('does not throw when Redis is unavailable', async () => {
    const { cacheIdempotentResponse } = await import('../middleware/idempotency.js');

    // Force a key even without real Redis — should fail gracefully
    const request = {
      headers: { 'idempotency-key': 'redis-down-key' },
      method: 'POST',
      url: '/api/tasks',
    };
    const reply = { statusCode: 201 };

    await expect(
      cacheIdempotentResponse(request as never, reply as never, '{"taskId":"t_1"}')
    ).resolves.not.toThrow();
  });
});
