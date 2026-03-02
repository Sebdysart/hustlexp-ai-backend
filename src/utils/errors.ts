/**
 * Extracts a human-readable message from an unknown caught value.
 * Use this in catch(error: unknown) blocks instead of (error as Error).message.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
