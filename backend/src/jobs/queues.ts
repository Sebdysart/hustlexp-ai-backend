/**
 * BullMQ Queue Configuration v1.0.0
 * 
 * SYSTEM GUARANTEES: Idempotency, Auditability, Backpressure
 * 
 * Queue topology by failure domain:
 * - critical_payments: Stripe webhooks, escrow state, XP awards (STRICT idempotency)
 * - critical_trust: Trust tier recalculations, fraud signals
 * - user_notifications: Email/SMS/push fanout (rate-limited)
 * - exports: CSV/PDF generation, R2 uploads, signed URL creation
 * - maintenance: Cleanup, TTL expiry, backfills
 * 
 * Hard rule: Payment and XP awarding must run in critical_payments only.
 * All handlers must be idempotent by construction (at-least-once processing assumed).
 * 
 * @see ARCHITECTURE.md §2.4 (Outbox pattern)
 */

import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';

// ============================================================================
// REDIS CONNECTION (Upstash)
// ============================================================================

/**
 * Create Redis connection for BullMQ
 * BullMQ requires ioredis-compatible connection (TCP, not REST API)
 * 
 * Upstash provides both:
 * - REST API (UPSTASH_REDIS_REST_URL) - for @upstash/redis client (caching, rate limiting)
 * - Direct TCP (UPSTASH_REDIS_URL) - for ioredis/BullMQ (job queues)
 * 
 * Hard rule: Use direct TCP connection for BullMQ, REST API for caching
 * 
 * For Upstash: Get direct TCP connection string from Upstash dashboard
 * Format: redis://default:{password}@{endpoint}.upstash.io:{port}
 * 
 * Alternatively: Use separate Redis instance for BullMQ (recommended for production)
 */
function createRedisConnection(): Redis {
  if (!config.redis.url) {
    throw new Error('Redis configuration missing (UPSTASH_REDIS_URL or REDIS_URL required for BullMQ). Get direct TCP connection string from Upstash dashboard.');
  }
  
  const redisUrl = config.redis.url;
  
  // Create ioredis client (BullMQ-compatible)
  // Upstash requires TLS for direct connections
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    // Upstash-specific settings: requires TLS for direct TCP connections
    tls: redisUrl.includes('upstash.io') ? {
      rejectUnauthorized: false, // Upstash uses self-signed certs
    } : undefined,
  });
  
  return redis;
}

// ============================================================================
// QUEUE DEFINITIONS
// ============================================================================

export type QueueName = 
  | 'critical_payments'
  | 'critical_trust'
  | 'user_notifications'
  | 'exports'
  | 'maintenance';

interface QueueConfig {
  name: QueueName;
  defaultJobOptions: QueueOptions['defaultJobOptions'];
  settings: QueueOptions['settings'];
}

/**
 * Queue configurations with failure domain isolation
 */
export const QUEUE_CONFIGS: Record<QueueName, QueueConfig> = {
  critical_payments: {
    name: 'critical_payments',
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000, // 1s, 2s, 4s, 8s, 16s
      },
      removeOnComplete: {
        age: 24 * 60 * 60, // Keep completed jobs for 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
      },
    },
    settings: {
      retryProcessDelay: 5000, // 5s delay between retries
      maxStalledCount: 1, // Fail after 1 stall (strict monitoring)
    },
  },
  
  critical_trust: {
    name: 'critical_trust',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s
      },
      removeOnComplete: {
        age: 12 * 60 * 60, // Keep completed jobs for 12 hours
        count: 500,
      },
      removeOnFail: {
        age: 3 * 24 * 60 * 60, // Keep failed jobs for 3 days
      },
    },
    settings: {
      retryProcessDelay: 10000, // 10s delay
      maxStalledCount: 2,
    },
  },
  
  user_notifications: {
    name: 'user_notifications',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000, // 5s, 10s, 20s
      },
      removeOnComplete: {
        age: 6 * 60 * 60, // Keep completed jobs for 6 hours
        count: 1000,
      },
      removeOnFail: {
        age: 1 * 24 * 60 * 60, // Keep failed jobs for 1 day
      },
    },
    settings: {
      retryProcessDelay: 5000,
      maxStalledCount: 3,
      // Rate limiting (per user)
      // TODO: Configure rate limits via BullMQ rate limiter
    },
  },
  
  exports: {
    name: 'exports',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000, // 30s, 60s, 120s (file generation can take time)
      },
      removeOnComplete: {
        age: 1 * 60 * 60, // Keep completed jobs for 1 hour
        count: 100,
      },
      removeOnFail: {
        age: 1 * 24 * 60 * 60, // Keep failed jobs for 1 day
      },
      timeout: 10 * 60 * 1000, // 10 minute timeout for file generation
    },
    settings: {
      retryProcessDelay: 10000,
      maxStalledCount: 2,
    },
  },
  
  maintenance: {
    name: 'maintenance',
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: 'fixed',
        delay: 60000, // 1 minute fixed delay
      },
      removeOnComplete: {
        age: 24 * 60 * 60, // Keep completed jobs for 24 hours
        count: 100,
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
      },
    },
    settings: {
      retryProcessDelay: 60000,
      maxStalledCount: 1,
    },
  },
};

// ============================================================================
// QUEUE FACTORY
// ============================================================================

const queueInstances = new Map<QueueName, Queue>();

/**
 * Get or create a BullMQ queue
 * Singleton pattern to ensure one queue instance per name
 */
export function getQueue(queueName: QueueName): Queue {
  if (queueInstances.has(queueName)) {
    return queueInstances.get(queueName)!;
  }
  
  const config = QUEUE_CONFIGS[queueName];
  const connection = createRedisConnection();
  
  const queue = new Queue(queueName, {
    connection,
    defaultJobOptions: config.defaultJobOptions,
    settings: config.settings,
  });
  
  queueInstances.set(queueName, queue);
  return queue;
}

// ============================================================================
// IDEMPOTENCY KEY GENERATION
// ============================================================================

/**
 * Generate idempotency key for events
 * Format: {event_type}:{aggregate_id}:{event_version}
 * 
 * This ensures same event can be processed twice without duplicate side effects
 */
export function generateIdempotencyKey(
  eventType: string,
  aggregateId: string,
  eventVersion: number = 1
): string {
  return `${eventType}:${aggregateId}:${eventVersion}`;
}

/**
 * Parse idempotency key to extract components
 */
export function parseIdempotencyKey(key: string): {
  eventType: string;
  aggregateId: string;
  eventVersion: number;
} {
  const parts = key.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid idempotency key format: ${key}`);
  }
  return {
    eventType: parts[0],
    aggregateId: parts[1],
    eventVersion: parseInt(parts[2], 10),
  };
}

// ============================================================================
// WORKER FACTORY
// ============================================================================

/**
 * Create a BullMQ worker for a queue
 * Workers should be created in a separate process (worker.ts)
 */
export function createWorker(
  queueName: QueueName,
  processor: (job: any) => Promise<void>,
  options?: Partial<WorkerOptions>
): Worker {
  const config = QUEUE_CONFIGS[queueName];
  const connection = createRedisConnection();
  
  return new Worker(
    queueName,
    processor,
    {
      connection,
      ...config.settings,
      ...options,
    }
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export { Queue, Worker };
export type { QueueOptions, WorkerOptions };
