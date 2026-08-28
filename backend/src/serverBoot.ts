export interface HttpServerBootDependencies<Server> {
  startup(): Promise<void>;
  listen(): Server;
  installHandlers(server: Server): void;
}

/**
 * The HTTP listener is a consequence of successful startup attestation.
 * A database, configuration, or migration failure must reject before any
 * socket can accept health or application traffic.
 */
export async function bootHttpServer<Server>(
  dependencies: HttpServerBootDependencies<Server>,
): Promise<Server> {
  await dependencies.startup();
  const server = dependencies.listen();
  dependencies.installHandlers(server);
  return server;
}
