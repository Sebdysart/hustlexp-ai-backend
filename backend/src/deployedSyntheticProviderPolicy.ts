type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const RAILWAY_SYNTHETIC_STORAGE_ORIGIN = 'https://storage.railway.app' as const;

export const DEPLOYED_SYNTHETIC_PROVIDER_MODES = Object.freeze({
  HX_AI_PROVIDER_MODE: 'deterministic',
  HX_MAPS_PROVIDER_MODE: 'deterministic',
  HX_VISION_PROVIDER_MODE: 'deterministic',
  HX_BIOMETRIC_PROVIDER_MODE: 'deterministic',
  HX_IDENTITY_PROVIDER_MODE: 'synthetic',
  HX_SCREENING_PROVIDER_MODE: 'synthetic',
  HX_CREDENTIAL_VERIFICATION_MODE: 'synthetic',
  HX_OBJECT_STORAGE_MODE: 'synthetic',
  HX_FINANCIAL_PROVIDER_MODE: 'fake',
  HX_OUTBOUND_COMMUNICATION_MODE: 'sink',
  HX_EMAIL_DELIVERY_MODE: 'sink',
  HX_SMS_DELIVERY_MODE: 'sink',
  HX_LIVE_DELIVERY: 'false',
  HX_TELEMETRY_EXPORT_MODE: 'disabled',
  HX_SYNTHETIC_OPERATOR_AUTH_MODE: 'signed_hmac',
} as const);

const FORBIDDEN_PROVIDER_NAME = /^(?:OPENAI_|DEEPSEEK_|GROQ_|ALIBABA_|ANTHROPIC_|GOOGLE_|GCP_|AZURE_|AWS_|R2_|FIREBASE_|TWILIO_|SENDGRID_|MAILGUN_|POSTMARK_|RESEND_|SES_|SNS_|FCM_|APNS_|PUSHER_|ONESIGNAL_|CHECKR_|TURNSTILE_|SENTRY_|DATADOG_|DD_|STRIPE_|PLAID_|DWOLLA_|ADYEN_|BRAINTREE_|PAYPAL_|SQUARE_|BANK_|LIVE_(?:PAYMENT|PAYOUT|IDENTITY|SCREENING|CREDENTIAL|STORAGE|OUTBOUND)_|(?:PAYMENT|PAYOUT|IDENTITY|SCREENING|CREDENTIAL|STORAGE|OUTBOUND)_PROVIDER_)/u;

const ALLOWED_PROVIDER_VARIABLES = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'STRIPE_MODE',
]);

function privateRailwayUrlErrors(
  name: string,
  value: string | undefined,
  protocols: readonly string[],
): string[] {
  if (!value?.trim()) return [`${name} is required for a deterministic synthetic provider`];
  try {
    const parsed = new URL(value);
    const errors: string[] = [];
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${name} must use ${protocols.join(' or ')}`);
    }
    if (!parsed.hostname.toLowerCase().endsWith('.railway.internal')) {
      errors.push(`${name} must use isolated Railway private networking`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      errors.push(`${name} may not embed credentials, query parameters, or fragments`);
    }
    return errors;
  } catch {
    return [`${name} must be a valid URL`];
  }
}

function exactModeErrors(env: Environment): string[] {
  return Object.entries(DEPLOYED_SYNTHETIC_PROVIDER_MODES).flatMap(([name, expected]) =>
    env[name] === expected ? [] : [`${name} must be ${expected}`],
  );
}

function exactSyntheticStorageErrors(env: Environment): string[] {
  const errors: string[] = [];
  try {
    const endpoint = new URL(env.S3_ENDPOINT ?? '');
    if (
      endpoint.origin !== RAILWAY_SYNTHETIC_STORAGE_ORIGIN
      || endpoint.pathname !== '/'
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) {
      errors.push(`S3_ENDPOINT must be the isolated Railway bucket origin ${RAILWAY_SYNTHETIC_STORAGE_ORIGIN}`);
    }
  } catch {
    errors.push(`S3_ENDPOINT must be the isolated Railway bucket origin ${RAILWAY_SYNTHETIC_STORAGE_ORIGIN}`);
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(env.AWS_ACCESS_KEY_ID ?? '')) {
    errors.push('AWS_ACCESS_KEY_ID must be a nonproduction Railway bucket access-key reference');
  }
  if ((env.AWS_SECRET_ACCESS_KEY?.trim().length ?? 0) < 32) {
    errors.push('AWS_SECRET_ACCESS_KEY must be a nonproduction Railway bucket secret reference');
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/u.test(env.BUCKET_NAME ?? '')) {
    errors.push('BUCKET_NAME must identify the isolated nonproduction Railway bucket');
  }
  if (env.RAILWAY_PROJECT_NAME !== 'hustlexp-nonprod' || !env.RAILWAY_PROJECT_ID?.trim()) {
    errors.push('synthetic object storage requires exact hustlexp-nonprod Railway project identity');
  }
  return errors;
}

function syntheticSinkErrors(env: Environment): string[] {
  return [
    ...privateRailwayUrlErrors('SMTP_URL', env.SMTP_URL, ['smtp:', 'smtps:']),
    ...privateRailwayUrlErrors('HX_SMS_SINK_URL', env.HX_SMS_SINK_URL, ['http:', 'https:']),
  ];
}

function secretLengthErrors(name: string, value: string | undefined): string[] {
  return (value?.trim().length ?? 0) >= 32
    ? []
    : [`${name} must contain at least 32 characters in deployed synthetic nonproduction`];
}

function forbiddenProviderVariables(env: Environment): string[] {
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim() ?? '';
    if (!value || ALLOWED_PROVIDER_VARIABLES.has(name)) continue;
    if (FORBIDDEN_PROVIDER_NAME.test(name)) {
      errors.push(`${name} must be absent in deployed synthetic nonproduction`);
    }
    if (/^(?:sk|rk|pk)_live_|^whsec_/u.test(value)) {
      errors.push(`${name} contains a live processor credential and must be absent`);
    }
    if (name.startsWith('HXOS_ALLOW_LOCAL_TEST_') && value === 'true') {
      errors.push(`${name} may not enable a local-only provider in deployed synthetic nonproduction`);
    }
  }
  return errors;
}

/**
 * Fail-closed provider inventory for a deployed preview or staging service.
 *
 * Synthetic deployment is a production-optimized Node runtime, but it is not
 * allowed to inherit any credential or selector that can reach a live AI,
 * maps, vision, biometric, identity, screening, storage, communications,
 * telemetry, or financial provider. The only credentials accepted here are
 * the isolated Railway bucket references in the exact hustlexp-nonprod
 * project and bounded HMAC secrets used by the fake webhook and named
 * synthetic-operator issuer. R2 and other provider selectors remain forbidden.
 */
export function deployedSyntheticProviderConfigurationErrors(
  env: Environment = process.env,
): string[] {
  const errors = [
    ...exactModeErrors(env),
    ...exactSyntheticStorageErrors(env),
    ...syntheticSinkErrors(env),
    ...secretLengthErrors('HX_FAKE_FINANCIAL_WEBHOOK_SECRET', env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET),
    ...secretLengthErrors('HX_SYNTHETIC_OPERATOR_AUTH_SECRET', env.HX_SYNTHETIC_OPERATOR_AUTH_SECRET),
    ...forbiddenProviderVariables(env),
  ];
  if (env.STRIPE_MODE !== 'test') {
    errors.push('STRIPE_MODE must be test without a Stripe credential');
  }
  if (env.HX_FAKE_FINANCIAL_PROVIDER_ENABLED !== 'true') {
    errors.push('HX_FAKE_FINANCIAL_PROVIDER_ENABLED must be true');
  }
  if (env.HX_PAYMENT_CREATION_MODE !== 'frozen') {
    errors.push('HX_PAYMENT_CREATION_MODE must be frozen');
  }
  if (env.HX_EXTERNAL_VALUE !== 'false') errors.push('HX_EXTERNAL_VALUE must be false');
  if (env.HX_LIVE_PROVIDER_ACCESS !== 'false') errors.push('HX_LIVE_PROVIDER_ACCESS must be false');
  return [...new Set(errors)];
}
