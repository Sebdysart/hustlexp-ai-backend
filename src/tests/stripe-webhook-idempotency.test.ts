/**
 * Stripe Webhook Idempotency Unit Tests
 *
 * Verifies that checkStripeEventIdempotency correctly interprets the result
 * of INSERT … ON CONFLICT DO NOTHING to distinguish new events from duplicates.
 *
 * The function receives a sql client as a parameter, so no module mocking is
 * needed — a vi.fn() tagged-template mock is passed directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkStripeEventIdempotency } from '../services/StripeService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock tagged-template function that returns `rows` when called.
 * Tagged templates are called as: fn`SQL ${value}` which desugars to fn(strings, ...values).
 */
function makeSqlMock(rows: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(rows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkStripeEventIdempotency', () => {
  it('returns false (not a duplicate) when INSERT succeeds and returns the new row', async () => {
    // INSERT succeeded → one row returned → event is new
    const mockSql = makeSqlMock([{ event_id: 'evt_new_123' }]);

    const isDuplicate = await checkStripeEventIdempotency('evt_new_123', mockSql as never);

    expect(isDuplicate).toBe(false);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('returns true (duplicate) when INSERT returns empty array due to ON CONFLICT DO NOTHING', async () => {
    // ON CONFLICT fired → no row returned → event was already processed
    const mockSql = makeSqlMock([]);

    const isDuplicate = await checkStripeEventIdempotency('evt_already_123', mockSql as never);

    expect(isDuplicate).toBe(true);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('passes the eventId as a template value to the sql client', async () => {
    const mockSql = makeSqlMock([{ event_id: 'evt_check_args' }]);

    await checkStripeEventIdempotency('evt_check_args', mockSql as never);

    // The mock was called with a TemplateStringsArray and interpolated values.
    // The second argument (first interpolated value) must be the event ID.
    const [, firstValue] = mockSql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(firstValue).toBe('evt_check_args');
  });

  it('propagates sql errors so callers can decide whether to skip or continue', async () => {
    const mockSql = vi.fn().mockRejectedValue(new Error('DB connection lost'));

    await expect(
      checkStripeEventIdempotency('evt_err', mockSql as never)
    ).rejects.toThrow('DB connection lost');
  });
});
