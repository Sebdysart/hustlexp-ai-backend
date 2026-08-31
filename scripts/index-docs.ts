/**
 * External semantic document indexing is release-frozen.
 *
 * This tombstone intentionally contains no provider SDK, endpoint, credential,
 * model, base URL, database write, or fallback embedding implementation.
 */

export const EXTERNAL_AI_TOOLING_DORMANT_ERROR =
  'EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:index-docs' as const;

export async function main(): Promise<never> {
  throw new Error(EXTERNAL_AI_TOOLING_DORMANT_ERROR);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : EXTERNAL_AI_TOOLING_DORMANT_ERROR);
  process.exitCode = 1;
});
