import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity';
import {
  startWorkerHealthServer,
  type WorkerHealthServer,
} from '../../src/jobs/worker-health-server';

const identity: BuildIdentity = {
  schema_version: 1,
  service: 'hustlexp-engine',
  revision: '00fb492f0c10ff23eb4db234f9dfbbb1e99b9ecf',
  built_at: '2026-07-22T10:23:48.000Z',
  environment: 'production',
  clean_source: true,
  source: 'test',
};

const handles: WorkerHealthServer[] = [];

async function create(options: Parameters<typeof startWorkerHealthServer>[0] = {}) {
  const handle = await startWorkerHealthServer({
    host: '127.0.0.1',
    port: 0,
    identity,
    ...options,
  });
  handles.push(handle);
  const address = handle.server.address() as AddressInfo;
  return {
    handle,
    url: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(handle => handle.close()));
});

describe('worker deployment health server', () => {
  it('stays unavailable until every worker and schedule has registered', async () => {
    const { handle, url } = await create({ production: true });

    const starting = await fetch(`${url}/health`);
    expect(starting.status).toBe(503);
    expect(await starting.json()).toMatchObject({
      service: 'hustlexp-worker',
      state: 'starting',
      ready: false,
    });

    handle.markReady();
    const ready = await fetch(`${url}/health/readiness`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      service: 'hustlexp-worker',
      state: 'ready',
      ready: true,
      build: identity,
    });
  });

  it('fails closed for an untrusted production build', async () => {
    const { handle, url } = await create({
      production: true,
      trustedIdentity: () => false,
    });
    handle.markReady();

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: 'ready', ready: false });
  });

  it('withdraws readiness before graceful shutdown', async () => {
    const { handle, url } = await create({ production: true });
    handle.markReady();
    handle.markShuttingDown();

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      state: 'shutting_down',
      ready: false,
    });
  });

  it('rejects unsupported paths and methods without leaking runtime state', async () => {
    const { url } = await create({ production: false });

    const missing = await fetch(`${url}/metrics`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const mutation = await fetch(`${url}/health`, { method: 'POST' });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get('allow')).toBe('GET');
  });
});
