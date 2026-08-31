import { describe, expect, it } from 'vitest';

import {
  DEPLOYED_SYNTHETIC_PROVIDER_MODES,
  deployedSyntheticProviderConfigurationErrors,
} from '../../src/deployedSyntheticProviderPolicy.js';

function deployedSyntheticEnvironment(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    ...DEPLOYED_SYNTHETIC_PROVIDER_MODES,
    S3_ENDPOINT: 'https://storage.railway.app',
    AWS_ACCESS_KEY_ID: 'syntheticRailwayAccessKey',
    AWS_SECRET_ACCESS_KEY: 'synthetic-railway-secret-reference-at-least-32',
    BUCKET_NAME: 'hustlexp-nonprod-fixtures',
    RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    RAILWAY_PROJECT_ID: 'railway-project-nonprod',
    SMTP_URL: 'smtp://message-sink.railway.internal:1025',
    HX_SMS_SINK_URL: 'http://synthetic-providers.railway.internal:8080/v1/messages/sms',
    HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: '10000000-0000-4000-8000-000000000005',
    HX_FAKE_FINANCIAL_WEBHOOK_SECRET: 'fake-financial-secret-reference-at-least-32',
    HX_SYNTHETIC_OPERATOR_AUTH_SECRET: 'synthetic-operator-secret-reference-at-least-32',
    STRIPE_MODE: 'test',
    HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'true',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    HX_EXTERNAL_VALUE: 'false',
    HX_LIVE_PROVIDER_ACCESS: 'false',
    ...overrides,
  };
}

describe('deployed synthetic provider policy', () => {
  it('requires the named completion-delivery sink actor in an otherwise valid staging posture', () => {
    expect(deployedSyntheticProviderConfigurationErrors(deployedSyntheticEnvironment())).toEqual([]);

    expect(
      deployedSyntheticProviderConfigurationErrors(
        deployedSyntheticEnvironment({ HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: undefined })
      )
    ).toContain(
      'HX_COMPLETION_DELIVERY_SINK_ACTOR_ID must identify the named synthetic completion-delivery service actor'
    );
    expect(
      deployedSyntheticProviderConfigurationErrors(
        deployedSyntheticEnvironment({ HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: 'not-a-uuid' })
      )
    ).toContain(
      'HX_COMPLETION_DELIVERY_SINK_ACTOR_ID must identify the named synthetic completion-delivery service actor'
    );
  });
});
