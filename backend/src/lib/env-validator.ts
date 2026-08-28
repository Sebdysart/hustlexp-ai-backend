/**
 * Runtime environment variable validator.
 *
 * Checks that all required environment variables are present before the
 * application starts.  Import and call `validateEnv()` early in the
 * bootstrap sequence (e.g. inside `src/index.ts`).
 */

const REQUIRED_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
  'JWT_SECRET',
  'R2_ACCOUNT_ID',
  'SESSION_ENCRYPTION_KEY',
] as const;

/**
 * Throws an error listing every required environment variable that is
 * missing or empty-string.
 */
export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(
    (key) => !process.env[key],
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}
