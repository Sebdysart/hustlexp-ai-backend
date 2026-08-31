import type pg from 'pg';

export const SYNTHETIC_SERVICE_CELL_AUTHORITY_ID =
  'c9000000-0000-4000-8000-000000000001';
export const SYNTHETIC_SERVICE_CELL_POSTAL_CODE = '00000';
export const SYNTHETIC_SERVICE_CELL_REGION_CODE = 'US-XQ';
export const SYNTHETIC_SERVICE_CELL_ROUGH_LOCATION = 'Synthetic XQ service area';

type Queryable = Pick<pg.Pool, 'query'>;

export async function ensureUniversalV1SyntheticServiceCell(
  database: Queryable,
): Promise<void> {
  const evidence = {
    fixture: 'hustlexp-universal-v1-required-test-service-cell-v1',
    synthetic: true,
    customer_data: false,
    provider_availability_claimed: false,
  };
  await database.query(
    `INSERT INTO universal_v1_service_cell_authorities(
       id, postal_code, region_code, rough_location, routing_availability,
       authority_environment, is_test, authority_kind, authority_version,
       supersedes_authority_id, evidence, evidence_sha256, effective_from
     ) VALUES (
       $1, $2, $3, $4, 'ACTIVE', 'local', TRUE, 'SYNTHETIC_FIXTURE', 1,
       NULL, $5::jsonb, encode(digest($5::jsonb::text, 'sha256'), 'hex'),
       TIMESTAMPTZ '2020-01-01 00:00:00+00'
     )
     ON CONFLICT (postal_code, authority_environment, authority_version)
     DO NOTHING`,
    [
      SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      SYNTHETIC_SERVICE_CELL_REGION_CODE,
      SYNTHETIC_SERVICE_CELL_ROUGH_LOCATION,
      JSON.stringify(evidence),
    ],
  );
  const authority = await database.query<{
    id: string;
    region_code: string;
    rough_location: string;
    routing_availability: string;
    authority_kind: string;
    is_test: boolean;
  }>(
    `SELECT id, region_code, rough_location, routing_availability,
            authority_kind, is_test
       FROM universal_v1_service_cell_authorities
      WHERE postal_code = $1
        AND authority_environment = 'local'
        AND authority_version = 1`,
    [SYNTHETIC_SERVICE_CELL_POSTAL_CODE],
  );
  const row = authority.rows[0];
  if (
    authority.rows.length !== 1
    || row?.id !== SYNTHETIC_SERVICE_CELL_AUTHORITY_ID
    || row.region_code !== SYNTHETIC_SERVICE_CELL_REGION_CODE
    || row.rough_location !== SYNTHETIC_SERVICE_CELL_ROUGH_LOCATION
    || row.routing_availability !== 'ACTIVE'
    || row.authority_kind !== 'SYNTHETIC_FIXTURE'
    || row.is_test !== true
  ) {
    throw new Error('Universal V1 synthetic service-cell authority is not exact');
  }
}
