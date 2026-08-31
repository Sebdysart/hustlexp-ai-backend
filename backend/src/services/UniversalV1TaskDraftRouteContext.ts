import type { QueryFn } from '../db.js';
import type {
  UniversalV1ServiceCellAuthoritySnapshot,
  UniversalV1ServiceCellEnvironment,
  UniversalV1ServiceCellResolution,
} from './UniversalV1TaskDraftIngress.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface ServiceCellAuthorityRow {
  id: string;
  postal_code: string;
  region_code: string;
  rough_location: string;
  routing_availability: 'ACTIVE' | 'WAITLIST' | 'UNAVAILABLE';
  authority_environment: UniversalV1ServiceCellEnvironment;
  authority_kind: 'SYNTHETIC_FIXTURE' | 'SIGNED_DATASET';
  authority_version: number;
  evidence_sha256: string;
}

export function universalV1ServiceCellEnvironment(
  env: Environment,
): UniversalV1ServiceCellEnvironment | null {
  const value = env.HX_ENVIRONMENT?.trim().toLowerCase();
  if (value === 'local' || value === 'preview' || value === 'staging' || value === 'production') {
    return value;
  }
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  if (
    (value === 'test' && nodeEnvironment === 'test')
    || (value === 'development' && nodeEnvironment !== 'production')
    || (!value && (nodeEnvironment === 'test' || nodeEnvironment === 'development'))
  ) {
    return 'local';
  }
  return null;
}

export function normalizeUniversalV1PostalCode(value: string | null | undefined): string | null {
  const match = /^(\d{5})(?:-\d{4})?$/u.exec(value?.trim() ?? '');
  return match?.[1] ?? null;
}

/**
 * Resolve one immutable service-cell authority at the exact server-observed
 * time. The table is append-only: only the unsuperseded chain tip is current,
 * and an expired tip never causes an older authority to become current again.
 */
export async function resolveUniversalV1ServiceCell(
  query: QueryFn,
  input: {
    postalCode: string | null | undefined;
    env: Environment;
    nowMs: number;
  },
): Promise<UniversalV1ServiceCellResolution> {
  const postalCode = normalizeUniversalV1PostalCode(input.postalCode);
  if (!postalCode) {
    return {
      postalCode: null,
      authority: null,
      blockerCodes: ['SERVICE_CELL_POSTAL_CODE_REQUIRED'],
    };
  }
  const environment = universalV1ServiceCellEnvironment(input.env);
  if (!environment) {
    return {
      postalCode,
      authority: null,
      blockerCodes: ['SERVICE_CELL_ENVIRONMENT_UNRESOLVED'],
    };
  }
  const observedAt = new Date(input.nowMs);
  if (!Number.isFinite(observedAt.getTime())) {
    return {
      postalCode,
      authority: null,
      blockerCodes: ['SERVICE_CELL_OBSERVATION_TIME_INVALID'],
    };
  }
  const result = await query<ServiceCellAuthorityRow>(
    `SELECT authority.id, authority.postal_code, authority.region_code,
            authority.rough_location, authority.routing_availability,
            authority.authority_environment, authority.authority_kind,
            authority.authority_version, authority.evidence_sha256
       FROM universal_v1_service_cell_authorities authority
      WHERE authority.postal_code = $1
        AND authority.authority_environment = $2
        AND authority.effective_from <= $3::timestamptz
        AND (authority.expires_at IS NULL OR authority.expires_at > $3::timestamptz)
        AND NOT EXISTS (
          SELECT 1
            FROM universal_v1_service_cell_authorities successor
           WHERE successor.supersedes_authority_id = authority.id
        )
      ORDER BY authority.authority_version DESC
      LIMIT 2`,
    [postalCode, environment, observedAt.toISOString()],
  );
  if (result.rows.length !== 1) {
    return {
      postalCode,
      authority: null,
      blockerCodes: [
        result.rows.length > 1
          ? 'SERVICE_CELL_AUTHORITY_AMBIGUOUS'
          : 'SERVICE_CELL_AUTHORITY_UNRESOLVED',
      ],
    };
  }
  const row = result.rows[0]!;
  const authority: UniversalV1ServiceCellAuthoritySnapshot = {
    id: row.id,
    postalCode: row.postal_code,
    regionCode: row.region_code,
    roughLocation: row.rough_location,
    availability: row.routing_availability,
    environment: row.authority_environment,
    authorityKind: row.authority_kind,
    authorityVersion: Number(row.authority_version),
    evidenceSha256: row.evidence_sha256.trim(),
  };
  return { postalCode, authority, blockerCodes: [] };
}
