/** External semantic PR document queries are release-frozen. */
export const EXTERNAL_AI_PR_QUERY_DORMANT_ERROR =
  'EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:query-docs-for-pr' as const;

export async function main(): Promise<never> {
  throw new Error(EXTERNAL_AI_PR_QUERY_DORMANT_ERROR);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : EXTERNAL_AI_PR_QUERY_DORMANT_ERROR);
  process.exitCode = 1;
});
