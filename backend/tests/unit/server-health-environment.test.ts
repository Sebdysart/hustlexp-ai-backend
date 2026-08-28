import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runtimeHealthEnvironment } from '../../src/serverHealthRoutes.js';

describe('API deployment health environment', () => {
  it('uses HX_ENVIRONMENT staging or preview ahead of production-optimized NODE_ENV', () => {
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: 'staging',
      NODE_ENV: 'production',
    })).toBe('staging');
    expect(runtimeHealthEnvironment({
      HX_ENVIRONMENT: ' PREVIEW ',
      NODE_ENV: 'production',
    })).toBe('preview');
    expect(runtimeHealthEnvironment({ NODE_ENV: 'production' })).toBe('production');
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
  });
});
