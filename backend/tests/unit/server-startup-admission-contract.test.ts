import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const server = readFileSync(
  resolve(process.cwd(), 'backend/src/server.ts'),
  'utf8',
);

describe('server startup admission contract', () => {
  it('awaits runtime database/schema admission before binding the socket', () => {
    const admission = server.indexOf('await startServer()');
    const bind = server.indexOf('const server = serve(');

    expect(admission).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(admission);
    expect(server).not.toContain('startServer().catch(');
  });

  it('requires production task-location cryptography before either runtime admits work', () => {
    const startup = readFileSync(
      resolve(process.cwd(), 'backend/src/serverStartup.ts'),
      'utf8',
    );
    const workers = readFileSync(
      resolve(process.cwd(), 'backend/src/jobs/workers.ts'),
      'utf8',
    );

    expect(startup).toContain('assertTaskLocationCryptoConfigured()');
    expect(workers).toContain('assertTaskLocationCryptoConfigured()');
    expect(workers.indexOf('assertTaskLocationCryptoConfigured()'))
      .toBeLessThan(workers.indexOf('verifyRuntimeSchema(log)'));
  });
});
