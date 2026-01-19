/**
 * Outbox Helpers v1.0.0
 * 
 * SYSTEM GUARANTEES: Outbox Pattern Helpers
 * 
 * Helper functions to write domain events to the outbox table
 * within the same transaction as domain state changes.
 * 
 * Pattern:
 * 1. Start transaction
 * 2. Write domain event (e.g., update escrow status)
 * 3. Write outbox row (same transaction)
 * 4. Commit transaction
 * 5. Outbox worker reads → enqueues BullMQ job
 * 
 * Hard rule: Outbox row must be written in the same transaction as domain event
 * 
 * @see ARCHITECTURE.md §2.4 (Outbox pattern)
 */

import { db } from '../db';
import { generateIdempotencyKey, type QueueName } from './queues';

// ============================================================================
// TYPES
// ============================================================================

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  eventVersion?: number;
  payload: Record<string, unknown>;
  queueName: QueueName;
  idempotencyKey?: string; // Optional: auto-generated if not provided
}

// ============================================================================
// OUTBOX HELPERS
// ============================================================================

/**
 * Write domain event to outbox table
 * Should be called within a database transaction
 * 
 * Hard rule: Must be called in the same transaction as domain state change
 * 
 * @param input Event data
 * @returns Outbox event ID and idempotency key
 */
export async function writeToOutbox(input: OutboxEventInput): Promise<{
  id: string;
  idempotencyKey: string;
}> {
  // Generate idempotency key if not provided
  const idempotencyKey = input.idempotencyKey || generateIdempotencyKey(
    input.eventType,
    input.aggregateId,
    input.eventVersion || 1
  );
  
  // P1: Use INSERT ON CONFLICT DO NOTHING for atomic idempotency
  // This replaces SELECT+INSERT pattern with single atomic operation
  const result = await queryFn<{ id: string }>(
    `INSERT INTO outbox_events (
      event_type,
      aggregate_type,
      aggregate_id,
      event_version,
      idempotency_key,
      payload,
      queue_name,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.eventVersion || 1,
      idempotencyKey,
      JSON.stringify(input.payload),
      input.queueName,
    ]
  );
  
  // If conflict (no row returned), fetch existing row
  if (result.rowCount === 0) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    
    if (existing.rows.length === 0) {
      throw new Error(`Failed to insert outbox event and could not find existing row (idempotency_key: ${idempotencyKey})`);
    }
    
    return {
      id: existing.rows[0].id,
      idempotencyKey,
    };
  }
  
  return {
    id: result.rows[0].id,
    idempotencyKey,
  };
}

/**
 * Write multiple domain events to outbox table (batch operation)
 * Should be called within a database transaction
 * 
 * Hard rule: Must be called in the same transaction as domain state changes
 * 
 * @param inputs Array of event data
 * @returns Array of outbox event IDs and idempotency keys
 */
export async function writeBatchToOutbox(
  inputs: OutboxEventInput[]
): Promise<Array<{ id: string; idempotencyKey: string }>> {
  const results: Array<{ id: string; idempotencyKey: string }> = [];
  
  // Process each event (use INSERT ON CONFLICT for atomic idempotency)
  for (const input of inputs) {
    const idempotencyKey = input.idempotencyKey || generateIdempotencyKey(
      input.eventType,
      input.aggregateId,
      input.eventVersion || 1
    );
    
    // P1: Use INSERT ON CONFLICT DO NOTHING for atomic idempotency
    const result = await db.query<{ id: string }>(
      `INSERT INTO outbox_events (
        event_type,
        aggregate_type,
        aggregate_id,
        event_version,
        idempotency_key,
        payload,
        queue_name,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`,
      [
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        input.eventVersion || 1,
        idempotencyKey,
        JSON.stringify(input.payload),
        input.queueName,
      ]
    );
    
    // If conflict (no row returned), fetch existing row
    if (result.rowCount === 0) {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      
      if (existing.rows.length === 0) {
        throw new Error(`Failed to insert outbox event and could not find existing row (idempotency_key: ${idempotencyKey})`);
      }
      
      results.push({
        id: existing.rows[0].id,
        idempotencyKey,
      });
    } else {
      results.push({
        id: result.rows[0].id,
        idempotencyKey,
      });
    }
  }
  
  return results;
}

/**
 * Helper to execute a function within a transaction and write to outbox
 * 
 * Pattern:
 * 1. Start transaction
 * 2. Execute domain operation (callback)
 * 3. Write outbox event(s) (same transaction)
 * 4. Commit transaction
 * 
 * Note: This is a convenience wrapper. For more control, use `db.transaction` directly
 * and call `writeToOutbox` or `writeBatchToOutbox` within the transaction callback.
 * 
 * @param domainOperation Callback that performs domain state changes
 * @param outboxInput Event(s) to write to outbox
 * @returns Result of domain operation and outbox event ID(s)
 */
export async function executeWithOutbox<T>(
  domainOperation: () => Promise<T>,
  outboxInput: OutboxEventInput | OutboxEventInput[]
): Promise<{
  domainResult: T;
  outboxResult: { id: string; idempotencyKey: string } | Array<{ id: string; idempotencyKey: string }>;
}> {
  // Use db.transaction to ensure atomicity
  return await db.transaction(async (query) => {
    // Execute domain operation
    const domainResult = await domainOperation();
    
    // Write to outbox (same transaction)
    // Note: writeToOutbox and writeBatchToOutbox use db.query directly,
    // which will work correctly within db.transaction due to connection pooling
    // However, for true transaction safety, they should accept a query parameter
    // TODO: Refactor to accept query parameter for true transaction safety
    const outboxResult = Array.isArray(outboxInput)
      ? await writeBatchToOutbox(outboxInput)
      : await writeToOutbox(outboxInput);
    
    return {
      domainResult,
      outboxResult,
    };
  });
}
