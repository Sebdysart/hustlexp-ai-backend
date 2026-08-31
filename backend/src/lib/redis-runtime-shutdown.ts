import { closeAllConnections } from '../jobs/queues.js';
import { shutdownPubSub } from '../realtime/redis-pubsub.js';
import { closeRedisCommandClient } from '../redis/RedisCommandPort.js';

let closePromise: Promise<void> | null = null;

async function runCloseSequence(): Promise<void> {
  const errors: unknown[] = [];

  for (const close of [
    closeAllConnections,
    shutdownPubSub,
    closeRedisCommandClient,
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to close one or more Redis runtime roles');
  }
}

/**
 * Close every Redis role in dependency order exactly once for this process.
 * This is a terminal lifecycle boundary; callers must not attempt to restart
 * queue or command-client consumers after it resolves.
 */
export function closeRedisRuntime(): Promise<void> {
  closePromise ??= runCloseSequence();
  return closePromise;
}
