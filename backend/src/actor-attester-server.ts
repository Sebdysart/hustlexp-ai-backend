import { serve } from '@hono/node-server';

import { logger } from './logger.js';
import { startActorAttester, type ActorAttesterStartup } from './actor-attester-startup.js';
import { bootHttpServer, waitForHttpListener } from './serverBoot.js';
import { shutdownServerResources, stopHttpIntake } from './serverLifecycle.js';
import { closeRedisCommandClient } from './redis/RedisCommandPort.js';

let startup: ActorAttesterStartup;
const server = await bootHttpServer({
  startup: async () => {
    startup = await startActorAttester();
    return startup;
  },
  listen: () => serve({ fetch: startup.app.fetch, port: startup.port, hostname: startup.hostname }),
  awaitListening: waitForHttpListener,
  installHandlers: (listeningServer) => {
    let shutdown: Promise<void> | undefined;
    const close = () => {
      shutdown ??= shutdownServerResources({
        closeHttp: () => stopHttpIntake(listeningServer),
        closeRedis: closeRedisCommandClient,
        closeDatabase: () => startup.closeDatabase(),
      }).then(
        () => {
          process.exit(0);
        },
        (error: unknown) => {
          logger.error({ err: error }, 'Actor-attester shutdown failed');
          process.exit(1);
        }
      );
      return shutdown;
    };
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
  },
  cleanupOnFailure: (partialServer, ownedStartup) =>
    shutdownServerResources({
      closeHttp: () => (partialServer ? stopHttpIntake(partialServer) : undefined),
      closeRedis: () => (ownedStartup ? closeRedisCommandClient() : undefined),
      closeDatabase: () => ownedStartup?.closeDatabase(),
    }),
}).catch((error) => {
  logger.fatal({ err: error }, 'Actor-attester startup failed');
  throw error;
});

const app = startup!.app;
export { app, server };
