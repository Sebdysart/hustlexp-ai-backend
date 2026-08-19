import { describe, expect, it } from 'vitest';
import {
  assertEngineOpsServiceKey,
  assertOpsAdminBearerKey,
  expectedEngineOpsServiceKey,
  OpsAuthError,
} from '../../src/routers/web/opsServiceKey';

describe('opsServiceKey', () => {
  it('prefers ENGINE_OPS_ADMIN_KEY when long enough', () => {
    expect(expectedEngineOpsServiceKey({
      ENGINE_OPS_ADMIN_KEY: 'engine-bridge-secret!!',
      OPS_ADMIN_KEY: 'fallback-ops-secret!!!',
    })).toBe('engine-bridge-secret!!');
  });

  it('falls back to OPS_ADMIN_KEY', () => {
    expect(expectedEngineOpsServiceKey({
      ENGINE_OPS_ADMIN_KEY: 'short',
      OPS_ADMIN_KEY: 'fallback-ops-secret!!!',
    })).toBe('fallback-ops-secret!!!');
  });

  it('rejects short keys with OpsAuthError', () => {
    expect(() => assertEngineOpsServiceKey('tiny', {
      ENGINE_OPS_ADMIN_KEY: 'engine-bridge-secret!!',
    })).toThrow(OpsAuthError);
  });

  it('accepts matching bearer keys for liquidity REST', () => {
    expect(() => assertOpsAdminBearerKey('ops-admin-liquidity!!', {
      OPS_ADMIN_KEY: 'ops-admin-liquidity!!',
    })).not.toThrow();
  });
});
