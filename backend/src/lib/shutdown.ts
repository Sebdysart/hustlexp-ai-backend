import { logger } from '../logger';

export interface ShutdownHandler {
  name: string;
  priority: number;
  handler: () => Promise<void>;
}

export class GracefulShutdown {
  private handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private readonly FORCE_EXIT_TIMEOUT = 45000;

  register(name: string, priority: number, handler: () => Promise<void>): void {
    this.handlers.push({ name, priority, handler });
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('Graceful shutdown initiated');

    const timeout = setTimeout(() => {
      logger.error('Force exit timeout reached, exiting with error');
      process.exit(1);
    }, this.FORCE_EXIT_TIMEOUT);

    const sortedHandlers = [...this.handlers].sort((a, b) => a.priority - b.priority);

    for (const { name, handler } of sortedHandlers) {
      try {
        logger.info(`Running shutdown handler: ${name}`);
        await handler();
        logger.info(`Shutdown handler completed: ${name}`);
      } catch (error) {
        logger.error({ err: error }, `Shutdown handler failed: ${name}`);
      }
    }

    clearTimeout(timeout);
    logger.info('Graceful shutdown completed');
    process.exit(0);
  }

  registerDefaults(deps: {
    httpServer?: { close: (callback?: (err?: Error) => void) => void };
    bullmqWorkers?: { close: () => Promise<void> }[];
    redis?: { quit: () => Promise<void> }[];
    prismaClients?: { $disconnect: () => Promise<void> }[];
  }): void {
    if (deps.httpServer) {
      this.register('httpServer', 0, async () => {
        return new Promise<void>((resolve, reject) => {
          deps.httpServer!.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    }

    if (deps.bullmqWorkers) {
      this.register('bullmqWorkers', 10, async () => {
        await Promise.all(deps.bullmqWorkers!.map((worker) => worker.close()));
      });
    }

    if (deps.redis) {
      this.register('redis', 20, async () => {
        await Promise.all(deps.redis!.map((client) => client.quit()));
      });
    }

    if (deps.prismaClients) {
      this.register('prismaClients', 30, async () => {
        await Promise.all(deps.prismaClients!.map((client) => client.$disconnect()));
      });
    }
  }

  setup(): void {
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received');
      this.shutdown();
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT received');
      this.shutdown();
    });
  }
}

export const gracefulShutdown = new GracefulShutdown();
