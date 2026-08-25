/**
 * Service-to-service ops key verification for engine-bridge → webOps.listEngineTasks.
 * Browser-facing ops procedures must use operationsAdminProcedure instead.
 */
import { timingSafeEqual } from 'node:crypto';

const MIN_KEY_LENGTH = 16;

export class OpsAuthError extends Error {
  readonly code = 'FORBIDDEN' as const;
  constructor(message = 'Invalid admin key') {
    super(message);
    this.name = 'OpsAuthError';
  }
}

function paddedEqual(provided: string, expected: string): boolean {
  const rawProvided = Buffer.from(provided, 'utf8');
  const rawExpected = Buffer.from(expected, 'utf8');
  const length = Math.max(rawProvided.length, rawExpected.length, 1);
  const paddedProvided = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  rawProvided.copy(paddedProvided);
  rawExpected.copy(paddedExpected);
  return timingSafeEqual(paddedProvided, paddedExpected);
}

/** Prefer ENGINE_OPS_ADMIN_KEY; fall back to OPS_ADMIN_KEY for local/test parity. */
export function expectedEngineOpsServiceKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const engine = (env.ENGINE_OPS_ADMIN_KEY ?? '').trim();
  if (engine.length >= MIN_KEY_LENGTH) return engine;
  return (env.OPS_ADMIN_KEY ?? '').trim();
}

export function assertEngineOpsServiceKey(
  provided: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expected = expectedEngineOpsServiceKey(env);
  if (
    !expected
    || provided.length < MIN_KEY_LENGTH
    || expected.length < MIN_KEY_LENGTH
    || !paddedEqual(provided, expected)
  ) {
    throw new OpsAuthError();
  }
}

/** Bearer / paste-key gate for interim REST liquidity (OpsGate). */
export function assertOpsAdminBearerKey(
  provided: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expected = (env.OPS_ADMIN_KEY ?? '').trim();
  const key = (provided ?? '').trim();
  if (
    !expected
    || key.length < MIN_KEY_LENGTH
    || expected.length < MIN_KEY_LENGTH
    || !paddedEqual(key, expected)
  ) {
    throw new OpsAuthError();
  }
}
