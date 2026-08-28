import { describe, expect, it } from 'vitest';
import {
  assertDisposableLoadTestAuthority,
  assertDisposableLoadTestReadback,
} from '../../scripts/disposable-load-test-policy.js';

const permitted = { HX_ALLOW_DESTRUCTIVE_LOAD_TEST: 'true' };

describe('destructive concurrency load-test containment', () => {
  it('accepts only an explicit exact disposable loopback identity', () => {
    expect(assertDisposableLoadTestAuthority(
      'postgresql://hx_ci_runner:synthetic@127.0.0.1:55432/hx_concurrency_test',
      permitted,
    )).toEqual({
      databaseName: 'hx_concurrency_test',
      databaseRole: 'hx_ci_runner',
      host: '127.0.0.1',
      port: 55432,
    });
  });

  it.each([
    [
      'postgresql://hx_ci_runner:synthetic@127.0.0.1:5432/hx_concurrency_test',
      {},
      'DESTRUCTIVE_LOAD_TEST_EXPLICIT_AUTHORITY_REQUIRED',
    ],
    [
      'postgresql://hx_ci_runner:synthetic@db.example.com:5432/hx_concurrency_test',
      permitted,
      'DESTRUCTIVE_LOAD_TEST_LOOPBACK_REQUIRED',
    ],
    [
      'postgresql://owner:synthetic@127.0.0.1:5432/hx_concurrency_test',
      permitted,
      'DESTRUCTIVE_LOAD_TEST_ROLE_NOT_ALLOWLISTED',
    ],
    [
      'postgresql://hx_ci_runner:synthetic@127.0.0.1:5432/hustlexp_production',
      permitted,
      'DESTRUCTIVE_LOAD_TEST_DATABASE_NOT_ALLOWLISTED',
    ],
  ])('rejects unsafe target %#', (url, env, code) => {
    expect(() => assertDisposableLoadTestAuthority(url, env)).toThrow(code);
  });

  it('requires exact database identity readback before the first mutation', () => {
    const expected = assertDisposableLoadTestAuthority(
      'postgresql://hx_ci_runner:synthetic@localhost:5432/hx_ci_system_test',
      permitted,
    );
    expect(() => assertDisposableLoadTestReadback(expected, {
      database_name: 'hustlexp_production',
      database_role: 'hx_ci_runner',
    })).toThrow('DESTRUCTIVE_LOAD_TEST_DATABASE_READBACK_MISMATCH');
    expect(() => assertDisposableLoadTestReadback(expected, {
      database_name: 'hx_ci_system_test',
      database_role: 'hx_ci_runner',
    })).not.toThrow();
  });
});
