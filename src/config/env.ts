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
  [key: string]: string | undefined;
}

export const env: EnvVars = new Proxy({} as EnvVars, {
  get(_target, prop: string) {
    return process.env[prop] || '';
  },
  has(_target, prop: string) {
    return prop in process.env;
  },
});
