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

  for (const category of ['furniture_assembly', 'moving'] as const) {
    const mappingEvidence = {
      fixture: 'hustlexp-universal-v1-required-test-price-book-mapping-v1',
      synthetic: true,
      customer_data: false,
      service_cell_authority_id: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      service_cell_authority_version: 1,
      service_cell_region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
      price_book_category: category,
      mapping_authority: 'EXPLICIT_SYNTHETIC_FIXTURE_ONLY',
    };
    await database.query(
      `INSERT INTO public.universal_v1_service_cell_price_book_mappings(
         service_cell_authority_id, service_cell_authority_version,
         price_book_id, price_book_policy_version, environment_class,
         mapping_version, evidence, evidence_sha256
       )
       SELECT $1::UUID, 1, price.id, price.policy_version, 'local', 1,
              $3::JSONB, encode(digest($3::JSONB::TEXT, 'sha256'), 'hex')
         FROM public.price_book price
        WHERE price.category = $2
          AND price.policy_version = 'hxos-price-book-v1'
          AND price.active IS TRUE
       ON CONFLICT (
         service_cell_authority_id, service_cell_authority_version,
         price_book_id, price_book_policy_version, environment_class,
         mapping_version
       ) DO NOTHING`,
      [
        SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
        category,
        JSON.stringify(mappingEvidence),
      ],
    );
  }
  const mappings = await database.query<{
    category: string;
    price_book_policy_version: string;
    environment_class: string;
    mapping_version: number;
    evidence_sha256_valid: boolean;
  }>(
    `SELECT price.category, mapping.price_book_policy_version,
            mapping.environment_class, mapping.mapping_version,
            btrim(mapping.evidence_sha256) =
              encode(digest(mapping.evidence::TEXT, 'sha256'), 'hex')
              AS evidence_sha256_valid
       FROM public.universal_v1_service_cell_price_book_mappings mapping
       JOIN public.price_book price ON price.id = mapping.price_book_id
      WHERE mapping.service_cell_authority_id = $1::UUID
        AND mapping.service_cell_authority_version = 1
        AND mapping.environment_class = 'local'
        AND mapping.mapping_version = 1
        AND price.category IN ('furniture_assembly', 'moving')
      ORDER BY price.category`,
    [SYNTHETIC_SERVICE_CELL_AUTHORITY_ID],
  );
  if (
    mappings.rows.length !== 2
    || mappings.rows.some((mapping) =>
      mapping.price_book_policy_version !== 'hxos-price-book-v1'
      || mapping.environment_class !== 'local'
      || mapping.mapping_version !== 1
      || mapping.evidence_sha256_valid !== true)
    || mappings.rows.map((mapping) => mapping.category).join(',')
      !== 'furniture_assembly,moving'
  ) {
    throw new Error('Universal V1 synthetic service-cell Price Book mapping is not exact');
  }
}
