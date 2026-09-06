import type { Server as NetServer } from 'node:net';

export interface HttpServerStartupHandle {
  closeDatabase(): Promise<void>;
}
export interface HttpServerBootDependencies<Server> {
  startup(): Promise<HttpServerStartupHandle | void>;
  listen(): Server;
  awaitListening?(server: Server): Promise<void>;
  installHandlers(server: Server): void;
  cleanupOnFailure?(
    server: Server | undefined,
    startup: HttpServerStartupHandle | undefined
  ): Promise<void>;
}

/**
 * The HTTP listener is a consequence of successful startup attestation.
 * A database, configuration, or migration failure must reject before any
 * socket can accept health or application traffic.
 */
export async function bootHttpServer<Server>(
  dependencies: HttpServerBootDependencies<Server>
): Promise<Server> {
  let startup: HttpServerStartupHandle | undefined;
  let server: Server | undefined;
  try {
    startup = (await dependencies.startup()) ?? undefined;
    server = dependencies.listen();
    await dependencies.awaitListening?.(server);
    dependencies.installHandlers(server);
    return server;
  } catch (error) {
    try {
      await dependencies.cleanupOnFailure?.(server, startup);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'HTTP_BOOT_AND_CLEANUP_FAILED');
    }
    throw error;
  }
}
/** Hono returns a Server before asynchronous bind failure/success is known. */
export async function waitForHttpListener(
  server: Pick<NetServer, 'listening' | 'once' | 'removeListener'>
): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', failed);
      server.removeListener('listening', ready);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
  });
}
