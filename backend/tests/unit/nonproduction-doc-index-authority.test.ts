import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assertNonproductionDocIndexAuthorized,
  NONPRODUCTION_DOC_EMBEDDING_SPEND_GRANT,
} from '../../src/jobs/nonproduction-doc-index-authority';

const localDatabaseUrl = 'postgresql://hx_ci_runner:secret@127.0.0.1:5432/hx_ci_system_test';
const localEnv = {
  HX_ALLOW_NONPROD_DOC_EMBEDDING: NONPRODUCTION_DOC_EMBEDDING_SPEND_GRANT,
  HX_ENVIRONMENT: 'local',
  HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
  HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
};

describe('nonproduction documentation-index authority', () => {
  it('requires the exact external-spend grant before parsing the target', () => {
    expect(() => assertNonproductionDocIndexAuthorized({
      ...localEnv,
      HX_ALLOW_NONPROD_DOC_EMBEDDING: 'true',
    }, localDatabaseUrl)).toThrow('NONPRODUCTION_DOC_INDEX_REFUSED:EXACT_SPEND_GRANT_REQUIRED');
  });

  it.each(['production', 'test', ' staging ', '', undefined])('rejects environment %s', (environment) => {
    expect(() => assertNonproductionDocIndexAuthorized({
      ...localEnv,
      HX_ENVIRONMENT: environment,
    }, localDatabaseUrl)).toThrow(
      'NONPRODUCTION_DOC_INDEX_REFUSED:HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING',
    );
  });

  it('allows an exact local test database binding', () => {
    expect(assertNonproductionDocIndexAuthorized(localEnv, localDatabaseUrl)).toMatchObject({
      environment: 'local',
      databaseName: 'hx_ci_system_test',
      roleName: 'hx_ci_runner',
      hostname: '127.0.0.1',
    });
  });

  it.each(['preview', 'staging'] as const)('requires the exact nonprod Railway project in %s', (environment) => {
    const env = {
      HX_ALLOW_NONPROD_DOC_EMBEDDING: NONPRODUCTION_DOC_EMBEDDING_SPEND_GRANT,
      HX_ENVIRONMENT: environment,
      HX_NONPRODUCTION_DATABASE_NAME: 'hustlexp_staging',
      HX_NONPRODUCTION_DATABASE_ROLE: 'hustlexp_staging_role',
      HX_NONPRODUCTION_DATABASE_HOST: 'postgres.railway.internal',
      HX_NONPRODUCTION_DATABASE_PORT: '5432',
    };
    const url = 'postgresql://hustlexp_staging_role:secret@postgres.railway.internal:5432/hustlexp_staging';

    expect(() => assertNonproductionDocIndexAuthorized(env, url)).toThrow(
      'NONPRODUCTION_DOC_INDEX_REFUSED:RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD',
    );
    expect(() => assertNonproductionDocIndexAuthorized({
      ...env,
      RAILWAY_PROJECT_NAME: ' hustlexp-nonprod ',
    }, url)).toThrow('NONPRODUCTION_DOC_INDEX_REFUSED:RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD');
    expect(assertNonproductionDocIndexAuthorized({
      ...env,
      RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    }, url)).toMatchObject({ environment });
  });

  it('keeps the indexing command as a nonzero external-AI tombstone', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../scripts/index-docs.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:index-docs');
    expect(source).toContain('process.exitCode = 1');
    expect(source).not.toMatch(/\bfetch\s*\(|new OpenAI|OPENAI_API_KEY|new Pool|client\.query/iu);
  });
});
