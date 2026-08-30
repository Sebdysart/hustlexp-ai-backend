import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runtimeHealthEnvironment } from '../../src/serverHealthRoutes.js';

describe('API deployment health environment', () => {
  it('keeps deployment lane separate from production-optimized NODE_ENV', () => {
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: 'staging',
      NODE_ENV: 'production',
    })).toBe('staging');
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: ' PREVIEW ',
      NODE_ENV: 'production',
    })).toBe('preview');
    expect(runtimeHealthEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: 'staging',
      NODE_ENV: 'development',
    })).toBe('unknown');
    expect(runtimeHealthEnvironment({ HX_ENVIRONMENT: 'preview' })).toBe('unknown');
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: 'production',
      NODE_ENV: 'development',
    })).toBe('unknown');
  });

  it('routes every API release-health evaluation through the runtime environment resolver', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/serverHealthRoutes.ts'),
      'utf8',
    );
    expect(source).not.toContain('runtimeReleaseManifest(config.app.env)');
    expect(source).not.toContain('exactReleaseReady(config.app.env)');
    expect(source).toContain('artifactDigest: buildIdentity.artifact_digest');
    expect(source.match(/runtimeHealthEnvironment\(\)/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(source.match(/nonproductionFinancialBootstrap: financialBootstrap/gu)?.length)
      .toBeGreaterThanOrEqual(5);
    expect(source.match(/&& financialBootstrap\.ready/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("app.get('/health/liveness', (context) =>");
    expect(source).toContain("paymentCreationMode === 'frozen'");
    expect(source).toContain("'disabled_by_policy'");
  });
});
