/**
 * Environment variable accessor.
 *
 * Provides typed access to process.env while keeping backward compatibility
 * with code that imports `env` from this module.
 *
 * NOTE: This module bridges the `src/` layer to process.env.
 * The canonical configuration lives in `backend/src/config.ts`.
 */

interface EnvVars {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DATABASE_URL: string;
  NODE_ENV: string;
  PORT: string;
  ALLOWED_ORIGINS: string;
  PAYOUTS_DISABLED: string;
  /** Set to 'true' to force degraded mode: all AI requests are queued instead of executed inline. */
  AI_DEGRADED_MODE: string;
  /** Maximum milliseconds a queued AI request is considered "pending" before expiry. Default: 5000 */
  AI_MAX_QUEUE_WAIT_MS: string;
  [key: string]: string | undefined;
}

export const env: EnvVars = new Proxy({} as EnvVars, {
  get(_target, prop: string) {
    return process.env[prop] ?? '';
  },
  has(_target, prop: string) {
    return prop in process.env;
  },
});
