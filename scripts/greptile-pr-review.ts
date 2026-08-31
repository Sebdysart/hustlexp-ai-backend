/**
 * External AI PR review is release-frozen.
 *
 * This tombstone intentionally contains no network request, provider SDK,
 * credential, endpoint, model, base URL, or pass-through success behavior.
 */

export const EXTERNAL_AI_REVIEW_DORMANT_ERROR =
  'EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:greptile-pr-review' as const;

export async function main(): Promise<never> {
  throw new Error(EXTERNAL_AI_REVIEW_DORMANT_ERROR);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : EXTERNAL_AI_REVIEW_DORMANT_ERROR);
  process.exitCode = 1;
});
