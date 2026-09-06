import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('runtime database pg private dependency contract', () => {
  it('pins the audited driver versions and private protocol/pool hooks', () => {
    const pgPackage = JSON.parse(
      readFileSync(join(dirname(require.resolve('pg')), '..', 'package.json'), 'utf8')
    ) as { readonly version?: unknown };
    const pgPoolPackage = JSON.parse(
      readFileSync(join(dirname(require.resolve('pg-pool')), 'package.json'), 'utf8')
    ) as { readonly version?: unknown };
    const PgPool = require('pg-pool') as {
      readonly prototype: { readonly _remove?: unknown; readonly _pulseQueue?: unknown };
    };
    const clientPrototype = pg.Client.prototype as unknown as {
      readonly _handleAuthSASL?: unknown;
    };

    expect(pgPackage.version).toBe('8.16.3');
    expect(pgPoolPackage.version).toBe('3.10.1');
    expect(typeof clientPrototype._handleAuthSASL).toBe('function');
    expect(typeof PgPool.prototype._remove).toBe('function');
    expect(typeof PgPool.prototype._pulseQueue).toBe('function');
  });
});
