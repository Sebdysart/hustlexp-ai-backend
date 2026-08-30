import { describe, expect, it } from 'vitest';
import {
  assertExternalAIProviderIOAuthorized,
  EXTERNAL_AI_PROVIDER_POLICY_VERSION,
  isExternalAIProviderConfigured,
} from '../../src/ai/ExternalAIProviderAuthority.js';

describe('external AI provider release authority', () => {
  it('is hard-dormant independently of credentials or environment labels', () => {
    const ambientKeys = [
      'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
      'ANTHROPIC_API_KEY', 'ALIBABA_API_KEY', 'DASHSCOPE_API_KEY',
      'AI_ROUTE_PRIMARY', 'HX_ENVIRONMENT',
    ] as const;
    const prior = new Map(ambientKeys.map((key) => [key, process.env[key]]));
    for (const key of ambientKeys) process.env[key] = 'present-but-not-authority';
    try {
      expect(EXTERNAL_AI_PROVIDER_POLICY_VERSION).toBe('external-ai-dormant-v1');
      expect(isExternalAIProviderConfigured()).toBe(false);
      expect(() => assertExternalAIProviderIOAuthorized('test-surface')).toThrow(
        'EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED:test-surface',
      );
    } finally {
      for (const key of ambientKeys) {
        const value = prior.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
