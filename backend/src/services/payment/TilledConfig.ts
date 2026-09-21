export type TilledEnvironment = 'sandbox' | 'production';

export interface TilledConfig {
  environment: TilledEnvironment;
  apiBaseUrl: string;
  secretKey: string;
  publishableKey: string;
  platformAccountId?: string;
}

export class TilledConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TilledConfigurationError';
  }
}

export function configuredQuotePaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
): 'local_test' | 'tilled' {
  const selected = env.QUOTE_PAYMENT_PROVIDER?.trim() || 'local_test';
  if (selected !== 'local_test' && selected !== 'tilled') {
    throw new TilledConfigurationError('Unsupported quote payment provider.');
  }
  return selected;
}

export function loadTilledConfig(env: NodeJS.ProcessEnv = process.env): TilledConfig {
  const environment = env.TILLED_ENV;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new TilledConfigurationError('TILLED_ENV must be sandbox or production.');
  }
  const secretKey = env.TILLED_SECRET_KEY?.trim();
  const publishableKey = env.TILLED_PUBLISHABLE_KEY?.trim();
  if (!secretKey || !publishableKey) {
    throw new TilledConfigurationError('Tilled API keys are not configured.');
  }
  return {
    environment,
    apiBaseUrl: environment === 'sandbox'
      ? 'https://sandbox-api.tilled.com'
      : 'https://api.tilled.com',
    secretKey,
    publishableKey,
    platformAccountId: env.TILLED_PLATFORM_ACCOUNT_ID?.trim() || undefined,
  };
}
