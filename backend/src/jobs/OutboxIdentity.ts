import { createHash } from 'node:crypto';

const OUTBOX_TRANSPORT_PREFIX = 'hxoutbox-';

/**
 * Map one durable database idempotency key to a BullMQ-safe transport ID.
 *
 * BullMQ 5.80 rejects most custom IDs containing `:`. Durable outbox keys use
 * colons by contract, so they remain signed inside `_outbox_key` while the
 * queue receives this deterministic, collision-resistant transport identity.
 */
export function outboxTransportJobId(durableOutboxKey: string): string {
  if (!durableOutboxKey.trim()) {
    throw new Error('OUTBOX_IDENTITY_INVALID: durable outbox key is required');
  }
  const digest = createHash('sha256').update(durableOutboxKey, 'utf8').digest('hex');
  return `${OUTBOX_TRANSPORT_PREFIX}${digest}`;
}

/**
 * Authenticate the reversible half of the outbox transport contract.
 *
 * The hash is intentionally one-way, so consumers must receive the durable
 * key in the job envelope and prove that BullMQ delivered it under the only
 * valid transport ID before using it in any database claim or ACK.
 */
export function requireOutboxDurableKey(
  jobId: unknown,
  durableOutboxKey: unknown,
): string {
  if (typeof durableOutboxKey !== 'string' || !durableOutboxKey.trim()) {
    throw new Error('OUTBOX_IDENTITY_INVALID: durable outbox key is required');
  }
  const expectedTransportId = outboxTransportJobId(durableOutboxKey);
  if (jobId !== expectedTransportId) {
    throw new Error(
      `OUTBOX_IDENTITY_MISMATCH: durable ${durableOutboxKey}, expected ${expectedTransportId}, received ${String(jobId)}`,
    );
  }
  return durableOutboxKey;
}
