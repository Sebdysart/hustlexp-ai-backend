import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import {
  decryptTaskLocation,
  encryptTaskLocation,
  TaskLocationCryptoError,
  type EncryptedTaskLocation,
  type StoredEncryptedTaskLocation,
} from './TaskLocationCrypto.js';

export interface SafetyLocationEvidence {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}

interface SafetyLocationRow extends StoredEncryptedTaskLocation {
  id: string;
  location_sharing_enabled: boolean;
  location_captured_at: Date | string | null;
  location_accuracy_meters: number | null;
  location_expires_at: Date | string | null;
  location_expired_at: Date | string | null;
  location_active: boolean;
}

function contextId(incidentId: string): string {
  return `safety-incident:${incidentId}`;
}

function cryptoFailure(): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Safety location protection is unavailable. No coordinates were stored or released.',
  });
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && value >= minimum && value <= maximum;
}

function validCapturedAt(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseEvidence(value: string): SafetyLocationEvidence {
  try {
    const parsed = JSON.parse(value) as Partial<SafetyLocationEvidence>;
    if (
      !boundedNumber(parsed.latitude, -90, 90)
      || !boundedNumber(parsed.longitude, -180, 180)
      || !boundedNumber(parsed.accuracyMeters, 1, 10000)
      || !validCapturedAt(parsed.capturedAt)
    ) throw new Error('invalid evidence');
    return parsed as SafetyLocationEvidence;
  } catch {
    throw cryptoFailure();
  }
}

export const TaskSafetyLocationService = {
  encrypt(incidentId: string, evidence: SafetyLocationEvidence): EncryptedTaskLocation {
    try {
      return encryptTaskLocation(contextId(incidentId), JSON.stringify(evidence));
    } catch (error) {
      if (error instanceof TaskLocationCryptoError) throw cryptoFailure();
      throw error;
    }
  },

  async getForAdmin(input: {
    incidentId: string;
    adminUserId: string;
    purpose: string;
  }): Promise<SafetyLocationEvidence & { expiresAt: string }> {
    return db.transaction(async (query) => {
      const result = await query<SafetyLocationRow>(
        `SELECT id, location_sharing_enabled, location_ciphertext, location_nonce,
                location_auth_tag, location_key_id, location_captured_at,
                location_accuracy_meters, location_expires_at, location_expired_at,
                (location_expires_at > clock_timestamp()) AS location_active
           FROM task_safety_incidents
          WHERE id = $1
          FOR SHARE`,
        [input.incidentId],
      );
      const row = result.rows[0];
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Safety incident not found' });
      if (!row.location_sharing_enabled) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The reporter did not share location.' });
      }
      if (
        row.location_expired_at
        || !row.location_expires_at
        || !row.location_active
      ) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Safety location evidence has expired.' });
      }
      let evidence: SafetyLocationEvidence;
      try {
        evidence = parseEvidence(decryptTaskLocation(contextId(input.incidentId), row));
      } catch (error) {
        if (error instanceof TaskLocationCryptoError || error instanceof TRPCError) throw cryptoFailure();
        throw error;
      }
      await query(
        `INSERT INTO task_safety_location_access_log (
           incident_id, admin_user_id, purpose, location_key_id
         ) VALUES ($1, $2, $3, $4)`,
        [input.incidentId, input.adminUserId, input.purpose, row.location_key_id],
      );
      return { ...evidence, expiresAt: new Date(row.location_expires_at).toISOString() };
    });
  },

  async expireDue(limit = 100): Promise<{ expired: number; incidentIds: string[] }> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const result = await db.query<{ id: string }>(
      `WITH due AS (
         SELECT id
           FROM task_safety_incidents
          WHERE location_ciphertext IS NOT NULL
            AND location_expired_at IS NULL
            AND location_expires_at <= clock_timestamp()
          ORDER BY location_expires_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE task_safety_incidents incident
          SET location_ciphertext = NULL,
              location_nonce = NULL,
              location_auth_tag = NULL,
              location_key_id = NULL,
              location_expired_at = clock_timestamp(),
              updated_at = NOW()
         FROM due
        WHERE incident.id = due.id
       RETURNING incident.id`,
      [boundedLimit],
    );
    return { expired: result.rows.length, incidentIds: result.rows.map((row) => row.id) };
  },
};
