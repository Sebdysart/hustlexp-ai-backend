type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const ATTESTER_DATABASE_CONFIGURATION = [
  'HX_ACTOR_ATTESTER_DATABASE_URL',
  'HX_WORK_ORDER_ATTESTER_DATABASE_ROLE',
] as const;

/**
 * The public API may call the attester over its authenticated internal
 * transport, but it must never receive the attester database login or be
 * started as the attester service itself.
 */
export function assertApiActorAttesterCredentialIsolation(env: Environment = process.env): void {
  if (env.SERVICE_ROLE?.trim().toLowerCase() === 'attester') {
    throw new Error('API_STARTUP_REFUSED:SERVICE_ROLE_ATTESTER_FORBIDDEN');
  }
  const leakedName = ATTESTER_DATABASE_CONFIGURATION.find((name) => env[name]?.trim());
  if (leakedName) {
    throw new Error(`API_STARTUP_REFUSED:ATTESTER_DATABASE_CONFIGURATION_PRESENT:${leakedName}`);
  }
}
