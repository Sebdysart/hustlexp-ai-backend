import {
  assertConfiguredNonproductionDatabaseTarget,
  type ExpectedNonproductionDatabaseTarget,
} from './nonproduction-database-target.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const NONPRODUCTION_DOC_EMBEDDING_SPEND_GRANT =
  'I_ACKNOWLEDGE_EXTERNAL_AI_SPEND';

function refuse(reason: string): never {
  throw new Error(`NONPRODUCTION_DOC_INDEX_REFUSED:${reason}`);
}

/**
 * Authorize the tooling-only documentation indexer before it constructs a
 * database pool, an AI client, or performs any external action.
 */
export function assertNonproductionDocIndexAuthorized(
  env: Environment,
  databaseUrl: string,
): ExpectedNonproductionDatabaseTarget {
  if (env.HX_ALLOW_NONPROD_DOC_EMBEDDING !== NONPRODUCTION_DOC_EMBEDDING_SPEND_GRANT) {
    return refuse('EXACT_SPEND_GRANT_REQUIRED');
  }

  const environment = env.HX_ENVIRONMENT;
  if (environment !== 'local' && environment !== 'preview' && environment !== 'staging') {
    return refuse('HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING');
  }

  if (
    (environment === 'preview' || environment === 'staging')
    && env.RAILWAY_PROJECT_NAME !== 'hustlexp-nonprod'
  ) {
    return refuse('RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD');
  }

  return assertConfiguredNonproductionDatabaseTarget(env, databaseUrl);
}
