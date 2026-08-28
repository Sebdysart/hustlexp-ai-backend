import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import {
  decryptTaskLocation,
  encryptTaskLocation,
  fingerprintsMatch,
  TaskLocationCryptoError,
  type StoredEncryptedTaskLocation,
} from './TaskLocationCrypto.js';

const log = logger.child({ module: 'task', service: 'TaskLocationService' });
const PROTECTED_LOCATION = 'Location protected until reservation';
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;
const GPS_PAIR = /-?\d{1,3}\.\d{3,}\s*[,/]\s*-?\d{1,3}\.\d{3,}/;
const STREET_ADDRESS = /^\s*\d{1,6}\s+.+\b(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|ct|court|way|pl(?:ace)?|pkwy|parkway|hwy|highway)\b/i;
const STREET_LEVEL_PART = /\b(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|ct|court|way|pl(?:ace)?|pkwy|parkway|hwy|highway)\b/i;
const UNIT_DETAIL = /^(?:apt|apartment|unit|suite|#)\s*[a-z0-9-]+$/i;
const PUBLIC_GPS_PAIR = /(-?\d{1,3}\.\d{4,})\u00b0?[NSns]?\s*[,/]\s*(-?\d{1,3}\.\d{4,})\u00b0?[EWew]?/g;
const PUBLIC_STREET_ADDRESS = /\b\d{1,5}\s+[A-Za-z0-9 .'#-]{2,50}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy)\b(?:\s*,?\s*(?:Apt|Apartment|Unit|Suite|#)\s*[A-Za-z0-9-]+)?/gi;

function cleanAreaPart(part: string): string {
  return part.replace(ZIP_CODE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert an exact address into city/region-level text safe for pre-reservation
 * feeds and dispatch offers. If an address cannot be generalized safely, fail
 * closed rather than echoing any part of it.
 */
export function deriveRoughArea(exactLocation?: string, explicitRoughArea?: string): string | undefined {
  const source = (explicitRoughArea || exactLocation || '').trim();
  if (!source) return undefined;
  if (GPS_PAIR.test(source)) return PROTECTED_LOCATION;

  const parts = source
    .split(',')
    .map(cleanAreaPart)
    .filter(Boolean)
    .filter((part) => !UNIT_DETAIL.test(part));

  if (parts.length > 0 && STREET_ADDRESS.test(parts[0])) {
    parts.shift();
  }

  const safeParts = parts
    .filter((part) => !STREET_ADDRESS.test(part) && !STREET_LEVEL_PART.test(part))
    .filter((part) => !/\d/.test(part))
    .slice(0, 2);

  if (safeParts.length === 0) return PROTECTED_LOCATION;

  const area = safeParts.join(', ').replace(/\s+area$/i, '').trim();
  return area ? `${area} area` : PROTECTED_LOCATION;
}

/** Remove street addresses and precise GPS pairs from fields shown publicly. */
export function redactPrivateLocation(text?: string): string | undefined {
  if (text === undefined) return undefined;
  return text
    .replace(PUBLIC_GPS_PAIR, '[location protected]')
    .replace(PUBLIC_STREET_ADDRESS, '[location protected]');
}

interface ReleaseLocationParams {
  taskId: string;
  workerId: string;
}

interface SetLocationParams {
  taskId: string;
  posterId: string;
  exactLocation: string;
}

interface LocationReleaseRow extends StoredEncryptedTaskLocation {
  worker_id: string | null;
  task_state: string;
  deadline: Date | string | null;
  escrow_state: string | null;
  trust_tier_required: number | null;
  worker_trust_tier: number | null;
  worker_trust_hold: boolean | null;
  worker_is_banned: boolean | null;
  worker_account_status: string | null;
  exact_location: string | null;
  location_fingerprint: string | null;
  expired_at: Date | string | null;
}

type LocationReleaseDecision =
  | { kind: 'allowed' }
  | { kind: 'error'; code: string; message: string };

function trustPolicyAllowsRelease(row: LocationReleaseRow): boolean {
  const requiredTier = row.trust_tier_required ?? 1;
  if (row.worker_trust_hold) return false;
  if (row.worker_is_banned) return false;
  if (row.worker_account_status !== 'ACTIVE') return false;
  return (row.worker_trust_tier ?? 0) >= requiredTier;
}

function assignmentReleaseDecision(
  row: LocationReleaseRow,
  workerId: string,
): LocationReleaseDecision | null {
  if (row.worker_id !== workerId || row.task_state !== 'ACCEPTED') {
    return {
      kind: 'error',
      code: 'LOCATION_NOT_RELEASED',
      message: 'Exact location is released only to the engine-reserved hustler.',
    };
  }
  return null;
}

function policyReleaseDecision(row: LocationReleaseRow): LocationReleaseDecision | null {
  if (row.escrow_state !== 'FUNDED') {
    return {
      kind: 'error',
      code: 'TASK_NOT_FUNDED',
      message: 'Exact location cannot be released before task funding is confirmed.',
    };
  }
  if (row.deadline && new Date(row.deadline).getTime() <= Date.now()) {
    return {
      kind: 'error',
      code: 'LOCATION_WINDOW_CLOSED',
      message: 'The exact-location access window closed at the task deadline.',
    };
  }
  if (!trustPolicyAllowsRelease(row)) {
    return {
      kind: 'error',
      code: 'TRUST_TIER_INSUFFICIENT',
      message: 'Hustler trust requirements are no longer satisfied.',
    };
  }
  if (row.expired_at) {
    return {
      kind: 'error',
      code: 'EXACT_LOCATION_EXPIRED',
      message: 'The exact location expired when the task reached a terminal state.',
    };
  }
  return null;
}

function materialReleaseDecision(row: LocationReleaseRow): LocationReleaseDecision | null {
  if (row.exact_location && !row.location_ciphertext) {
    return {
      kind: 'error',
      code: 'LOCATION_REENCRYPTION_REQUIRED',
      message: 'The Poster must reconfirm this legacy task location before it can be released.',
    };
  }
  if (
    !row.location_ciphertext
    || !row.location_nonce
    || !row.location_auth_tag
    || !row.location_key_id
  ) {
    return {
      kind: 'error',
      code: 'EXACT_LOCATION_MISSING',
      message: 'No exact location is stored for this task.',
    };
  }
  return null;
}

function evaluateLocationRelease(
  row: LocationReleaseRow | undefined,
  workerId: string,
): LocationReleaseDecision {
  if (!row) return { kind: 'error', code: 'NOT_FOUND', message: 'Task not found' };
  return assignmentReleaseDecision(row, workerId)
    ?? policyReleaseDecision(row)
    ?? materialReleaseDecision(row)
    ?? { kind: 'allowed' };
}

function cryptoErrorResult(error: TaskLocationCryptoError): ServiceResult<never> {
  const message = error.code === 'INVALID_LOCATION'
    ? error.message
    : 'Exact-location protection is unavailable. No location data was stored or released.';
  return { success: false, error: { code: error.code, message } };
}

export const TaskLocationService = {
  setByPoster: async (
    params: SetLocationParams
  ): Promise<ServiceResult<{ stored: true; idempotencyReplayed: boolean }>> => {
    try {
      const result = await db.transaction(async (query) => {
        const task = await query<{ poster_id: string; worker_id: string | null; state: string }>(
          `SELECT poster_id, worker_id, state FROM tasks WHERE id = $1 FOR UPDATE`,
          [params.taskId]
        );
        const row = task.rows[0];
        if (!row) return { kind: 'error' as const, code: 'NOT_FOUND', message: 'Task not found' };
        if (row.poster_id !== params.posterId) {
          return { kind: 'error' as const, code: 'FORBIDDEN', message: 'Only the task owner can set the service location.' };
        }
        if (row.worker_id || !['OPEN', 'MATCHING'].includes(row.state)) {
          return {
            kind: 'error' as const,
            code: 'LOCATION_LOCKED',
            message: 'The service location cannot change after reservation.',
          };
        }
        const encrypted = encryptTaskLocation(params.taskId, params.exactLocation);
        const existing = await query<{ location_fingerprint: string | null }>(
          `SELECT location_fingerprint FROM task_location_vault WHERE task_id = $1`,
          [params.taskId]
        );
        if (fingerprintsMatch(existing.rows[0]?.location_fingerprint, encrypted.fingerprint)) {
          return { kind: 'success' as const, replayed: true };
        }
        await query(
          `INSERT INTO task_location_vault (
             task_id, exact_location, location_ciphertext, location_nonce,
             location_auth_tag, location_key_id, location_fingerprint
           ) VALUES ($1, NULL, $2, $3, $4, $5, $6)
           ON CONFLICT (task_id) DO UPDATE
           SET exact_location = NULL,
               location_ciphertext = EXCLUDED.location_ciphertext,
               location_nonce = EXCLUDED.location_nonce,
               location_auth_tag = EXCLUDED.location_auth_tag,
               location_key_id = EXCLUDED.location_key_id,
               location_fingerprint = EXCLUDED.location_fingerprint,
               released_at = NULL,
               released_to = NULL,
               expired_at = NULL,
               expiration_reason = NULL`,
          [
            params.taskId,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authTag,
            encrypted.keyId,
            encrypted.fingerprint,
          ]
        );
        return { kind: 'success' as const, replayed: false };
      });
      if (result.kind === 'error') {
        return { success: false, error: { code: result.code, message: result.message } };
      }
      return { success: true, data: { stored: true, idempotencyReplayed: result.replayed } };
    } catch (error) {
      if (error instanceof TaskLocationCryptoError) return cryptoErrorResult(error);
      log.error(
        { taskId: params.taskId, posterId: params.posterId, err: error instanceof Error ? error.message : String(error) },
        'Exact task location storage failed'
      );
      return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
    }
  },
  releaseToReservedWorker: async (
    params: ReleaseLocationParams
  ): Promise<ServiceResult<{ exactLocation: string }>> => {
    try {
      const result = await db.transaction(async (query) => {
        const locked = await query<LocationReleaseRow>(
          `SELECT
             t.worker_id,
             t.state AS task_state,
             t.deadline,
             t.trust_tier_required,
             (SELECT e.state FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS escrow_state,
             (SELECT u.trust_tier FROM users u WHERE u.id = $2) AS worker_trust_tier,
             (SELECT u.trust_hold FROM users u WHERE u.id = $2) AS worker_trust_hold,
             (SELECT u.is_banned FROM users u WHERE u.id = $2) AS worker_is_banned,
             (SELECT u.account_status FROM users u WHERE u.id = $2) AS worker_account_status,
             v.exact_location,
             v.location_ciphertext,
             v.location_nonce,
             v.location_auth_tag,
             v.location_key_id,
             v.location_fingerprint,
             v.expired_at
           FROM tasks t
           LEFT JOIN task_location_vault v ON v.task_id = t.id
           WHERE t.id = $1
           FOR UPDATE OF t`,
          [params.taskId, params.workerId]
        );
        const row = locked.rows[0];
        const decision = evaluateLocationRelease(row, params.workerId);
        if (decision.kind === 'error') return decision;
        const exactLocation = decryptTaskLocation(params.taskId, row);

        await query(
          `UPDATE task_location_vault
           SET released_at = COALESCE(released_at, NOW()),
               released_to = COALESCE(released_to, $2)
           WHERE task_id = $1`,
          [params.taskId, params.workerId]
        );
        await query(
          `INSERT INTO task_location_access_log (task_id, worker_id, access_reason, location_key_id)
           VALUES ($1, $2, 'engine_reserved_worker', $3)`,
          [params.taskId, params.workerId, row.location_key_id]
        );

        return { kind: 'success' as const, exactLocation };
      });

      if (result.kind === 'error') {
        log.warn(
          { taskId: params.taskId, workerId: params.workerId, code: result.code },
          'Exact task location release denied'
        );
        return { success: false, error: { code: result.code, message: result.message } };
      }

      log.info(
        { taskId: params.taskId, workerId: params.workerId, releasePolicy: 'engine_reserved_worker' },
        'Exact task location released'
      );
      return { success: true, data: { exactLocation: result.exactLocation } };
    } catch (error) {
      if (error instanceof TaskLocationCryptoError) {
        log.error(
          { taskId: params.taskId, workerId: params.workerId, code: error.code },
          'Encrypted task location release failed closed'
        );
        return cryptoErrorResult(error);
      }
      log.error(
        { taskId: params.taskId, workerId: params.workerId, err: error instanceof Error ? error.message : String(error) },
        'Exact task location release failed'
      );
      return {
        success: false,
        error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
      };
    }
  },
};
