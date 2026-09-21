export type TilledEnvironment = 'sandbox' | 'production';

export interface TilledConfig {
  environment: TilledEnvironment;
  apiBaseUrl: string;
  secretKey: string;
  publishableKey: string;
  platformAccountId?: string;
}

export interface TilledOnboardingConfig {
  environment: TilledEnvironment;
  apiBaseUrl: string;
  secretKey: string;
  platformAccountId: string;
  defaultPricingTemplateId: string;
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

export function loadTilledOnboardingConfig(
  env: NodeJS.ProcessEnv = process.env,
): TilledOnboardingConfig {
  const environment = env.TILLED_ENV;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new TilledConfigurationError('TILLED_ENV must be sandbox or production.');
  }
  const secretKey = env.TILLED_SECRET_KEY?.trim();
  const platformAccountId = env.TILLED_PLATFORM_ACCOUNT_ID?.trim();
  const defaultPricingTemplateId = env.TILLED_DEFAULT_PRICING_TEMPLATE_ID?.trim();

  if (!secretKey) {
    throw new TilledConfigurationError('Tilled API secret is not configured.');
  }
  if (!platformAccountId || !/^acct_[A-Za-z0-9_]+$/.test(platformAccountId)) {
    throw new TilledConfigurationError('Tilled platform account is not configured.');
  }
  if (!defaultPricingTemplateId) {
    throw new TilledConfigurationError('Tilled onboarding pricing template is not configured.');
  }

  return {
    environment,
    apiBaseUrl: environment === 'sandbox'
      ? 'https://sandbox-api.tilled.com'
      : 'https://api.tilled.com',
    secretKey,
    platformAccountId,
    defaultPricingTemplateId,
  };
}
