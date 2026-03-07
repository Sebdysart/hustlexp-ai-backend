const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'STRIPE_SECRET_KEY',
  'JWT_SECRET',
  'R2_ACCOUNT_ID',
] as const;

export function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[Startup] Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join('\n')}\n\nSet these before starting the server.`
    );
  }
  console.log('[Startup] All required environment variables present ✓');
}
