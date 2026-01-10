/**
 * AIEventService v1.0.0
 * 
 * CONSTITUTIONAL: Captures immutable AI inputs
 * 
 * All AI inputs are logged to ai_events table with payload hashing.
 * This provides an audit trail and enables replay/debugging.
 * 
 * @see schema.sql §7.1 (ai_events table)
 * @see AI_INFRASTRUCTURE.md §6.1
 */

import { db } from '../db';
import type { ServiceResult, AIEvent } from '../types';
import { createHash } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

interface CreateAIEventParams {
  subsystem: string;
  eventType: string;
  actorUserId?: string;
  subjectUserId?: string;
  taskId?: string;
  disputeId?: string;
  payload: Record<string, unknown>;
  schemaVersion: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const AIEventService = {
  /**
   * Create an AI event (immutable input log)
   * Payload is hashed for integrity verification
   */
  create: async (params: CreateAIEventParams): Promise<ServiceResult<AIEvent>> => {
    const {
      subsystem,
      eventType,
      actorUserId,
      subjectUserId,
      taskId,
      disputeId,
      payload,
      schemaVersion,
    } = params;
    
    try {
      // Hash payload (SHA-256)
      const payloadJson = JSON.stringify(payload);
      const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
      
      const result = await db.query<AIEvent>(
        `INSERT INTO ai_events (
          subsystem, event_type, actor_user_id, subject_user_id,
          task_id, dispute_id, payload, payload_hash, schema_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          subsystem,
          eventType,
          actorUserId,
          subjectUserId,
          taskId,
          disputeId,
          JSON.stringify(payload),
          payloadHash,
          schemaVersion,
        ]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get AI event by ID
   */
  getById: async (eventId: string): Promise<ServiceResult<AIEvent>> => {
    try {
      const result = await db.query<AIEvent>(
        'SELECT * FROM ai_events WHERE id = $1',
        [eventId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI event ${eventId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

export default AIEventService;
