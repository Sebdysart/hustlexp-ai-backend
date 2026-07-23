import { createServer, type Server } from 'node:http';
import {
  buildIdentity as runtimeBuildIdentity,
  isTrustedBuildIdentity,
  type BuildIdentity,
} from '../buildIdentity.js';

export type WorkerHealthState = 'starting' | 'ready' | 'shutting_down';

export interface WorkerHealthServer {
  server: Server;
  markReady(): void;
  markShuttingDown(): void;
  close(): Promise<void>;
}

interface WorkerHealthServerOptions {
  host?: string;
  port?: number;
  production?: boolean;
  identity?: BuildIdentity;
  trustedIdentity?: (identity: BuildIdentity) => boolean;
}

function resolvePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3000;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startWorkerHealthServer(
  options: WorkerHealthServerOptions = {},
): Promise<WorkerHealthServer> {
  const identity = options.identity ?? runtimeBuildIdentity;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const trustedIdentity = options.trustedIdentity ?? isTrustedBuildIdentity;
  let state: WorkerHealthState = 'starting';

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://worker.local').pathname;
    const supportedPath = path === '/health' || path === '/health/readiness';

    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');

    if (!supportedPath) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const trustedBuild = !production || trustedIdentity(identity);
    const ready = state === 'ready' && trustedBuild;
    response.writeHead(ready ? 200 : 503);
    response.end(JSON.stringify({
      status: ready ? 'healthy' : 'unhealthy',
      service: 'hustlexp-worker',
      state,
      ready,
      build: identity,
    }));
  });

  await listen(server, options.port ?? resolvePort(process.env.PORT), options.host ?? '0.0.0.0');

  return {
    server,
    markReady() {
      state = 'ready';
    },
    markShuttingDown() {
      state = 'shutting_down';
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
