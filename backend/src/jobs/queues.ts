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

import { Queue, QueueOptions, Worker, WorkerOptions, Job, JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { createHmac } from 'crypto';
import { config } from '../config.js';
import { logger as rootLogger } from '../logger.js';

const dlqLog = rootLogger.child({ subsystem: 'dlq-monitor' });

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
    // W46-1 FIX: BullMQ requires maxRetriesPerRequest=null. Any non-null value
    // causes MaxRetriesPerRequestError on transient Redis blips, crashing all
    // workers instead of retrying the job via the BullMQ backoff strategy.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    // Upstash-specific settings: requires TLS for direct TCP connections
    tls: redisUrl.includes('upstash.io') ? {} : undefined,
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
  | 'maintenance'
  | 'tax_reporting'
  | 'biometric_analysis'
  | 'expertise_recalc'
  | 'xp_tax_reminders';

interface QueueConfig {
  name: QueueName;
  defaultJobOptions: QueueOptions['defaultJobOptions'];
  workerOptions?: Partial<WorkerOptions>; // Worker-level settings (e.g., maxStalledCount, lockDuration)
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
    workerOptions: {
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
    workerOptions: {
      maxStalledCount: 2,
      // W-18 FIX: Fraud detection makes nested AI calls (LogisticsAIService.detectImpossibleTravel)
      // that can exceed BullMQ's default 30s lockDuration. Without this, BullMQ considers the
      // worker stalled and re-queues the job, causing overlap and duplicate AI calls.
      lockDuration: 120000, // 2 minutes — sufficient for nested AI call chains
      lockRenewTime: 30000, // Renew lock every 30s to keep it alive during long runs
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
    workerOptions: {
      maxStalledCount: 3,
      // Rate limiting: Max 50 notifications per second to avoid overwhelming push/email providers
      limiter: {
        max: 50,
        duration: 1000,
      },
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
      // Note: timeout moved to worker-level lockDuration config
    },
    workerOptions: {
      maxStalledCount: 2,
      lockDuration: 10 * 60 * 1000, // 10 minute lock for file generation
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
    workerOptions: {
      maxStalledCount: 1,
    },
  },

  tax_reporting: {
    name: 'tax_reporting',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000, // 30s, 60s, 120s
      },
      removeOnComplete: {
        age: 7 * 24 * 60 * 60, // Keep completed jobs for 7 days
        count: 50,
      },
      removeOnFail: {
        age: 30 * 24 * 60 * 60, // Keep failed jobs for 30 days
      },
    },
    workerOptions: {
      maxStalledCount: 1,
    },
  },

  biometric_analysis: {
    name: 'biometric_analysis',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s
      },
      removeOnComplete: {
        age: 12 * 60 * 60, // 12 hours
        count: 500,
      },
      removeOnFail: {
        age: 3 * 24 * 60 * 60, // 3 days
      },
    },
    workerOptions: {
      maxStalledCount: 2,
      concurrency: 3,
    },
  },

  expertise_recalc: {
    name: 'expertise_recalc',
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000, // 30s, 60s, 120s
      },
      removeOnComplete: {
        age: 24 * 60 * 60, // 24 hours
        count: 10,
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
    workerOptions: {
      maxStalledCount: 1,
    },
  },

  xp_tax_reminders: {
    name: 'xp_tax_reminders',
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: 'fixed',
        delay: 60000, // 1 minute
      },
      removeOnComplete: {
        age: 24 * 60 * 60, // 24 hours
        count: 10,
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
    workerOptions: {
      maxStalledCount: 1,
    },
  },
};

// ============================================================================
// QUEUE FACTORY
// ============================================================================

const queueInstances = new Map<QueueName, Queue>();

// Tracks every ioredis connection created by getQueue / createWorker so they
// can all be cleanly disconnected on graceful shutdown (W-06 fix).
const connectionInstances = new Map<string, Redis>();

/**
 * Close all tracked ioredis connections.
 * Call this during graceful shutdown before the process exits.
 */
export async function closeAllConnections(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [key, conn] of connectionInstances.entries()) {
    closePromises.push(
      conn.quit().then(() => undefined).catch((err: unknown) => {
        rootLogger.warn({ err, connectionKey: key }, 'Error closing Redis connection');
      })
    );
  }
  await Promise.all(closePromises);
  connectionInstances.clear();
}

/**
 * Get or create a BullMQ queue
 * Singleton pattern to ensure one queue instance per name
 */
function getQueue(queueName: QueueName): Queue {
  if (queueInstances.has(queueName)) {
    return queueInstances.get(queueName)!;
  }

  const queueConfig = QUEUE_CONFIGS[queueName];
  const connection = createRedisConnection();
  connectionInstances.set(`${queueName}:queue`, connection);

  const queue = new Queue(queueName, {
    connection: connection as unknown as QueueOptions['connection'],
    defaultJobOptions: queueConfig.defaultJobOptions,
  });

  queueInstances.set(queueName, queue);
  return queue;
}

/**
 * Enqueue a one-off job through the only supported producer boundary.
 *
 * Requiring a non-empty deterministic jobId here prevents a future internal
 * caller from silently opting out of BullMQ deduplication. Raw Queue instances
 * deliberately remain private to this module.
 */
export async function enqueueJob(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  options: JobsOptions & { jobId: string },
): Promise<Job> {
  if (!options?.jobId?.trim()) {
    throw new Error('QUEUE_JOB_ID_REQUIRED: one-off jobs require a deterministic jobId');
  }
  return getQueue(queueName).add(jobName, data, options);
}

/**
 * Register a repeatable job with a deterministic producer identity. BullMQ
 * also keys repeat schedules by name and pattern; the jobId closes the direct
 * producer surface and makes the intent explicit in audit output.
 */
export async function enqueueRepeatableJob(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  pattern: string,
): Promise<Job> {
  if (!pattern.trim()) {
    throw new Error('QUEUE_REPEAT_PATTERN_REQUIRED');
  }
  const stableName = `${queueName}-${jobName}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  return getQueue(queueName).add(jobName, data, {
    jobId: `scheduled-${stableName}`,
    repeat: { pattern },
  });
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
 * Parse idempotency key to extract components.
 *
 * Supports both the standard 3-segment format ({eventType}:{aggregateId}:{version})
 * and extended surge/discriminator keys with 4+ segments
 * (e.g. 'task.instant_available:taskId:hustlerId:surge1').
 * For extended keys, parts[0] is eventType, parts[1] is aggregateId, and
 * parts.slice(2).join(':') is treated as the discriminator suffix (returned as
 * a non-numeric NaN eventVersion — callers that need the raw suffix should use
 * the key directly).
 */
export function parseIdempotencyKey(key: string): {
  eventType: string;
  aggregateId: string;
  eventVersion: number;
} {
  const parts = key.split(':');
  if (parts.length < 3) {
    throw new Error(`Invalid idempotency key format: ${key}`);
  }
  return {
    eventType: parts[0],
    aggregateId: parts[1],
    // W46-3 FIX: For 4+-segment surge keys (e.g., 'eventType:aggregateId:version:suffix'),
    // parse only parts[2] as the numeric version. Previously, parts.slice(2).join(':')
    // produced a non-numeric string like 'version:suffix' → parseInt → NaN, which
    // corrupted deduplication IDs. The surge discriminator suffix lives in parts[3+].
    eventVersion: parseInt(parts[2], 10),
  };
}

// ============================================================================
// WORKER FACTORY
// ============================================================================

/**
 * Create a BullMQ worker for a queue.
 *
 * Bug 3 Fix — DLQ monitoring:
 * Every worker now attaches a 'failed' event listener that fires when a job
 * exhausts all retry attempts. The listener emits a CRITICAL-level log with
 * the queue name, job ID, job name, attempt count, and error message so that
 * on-call engineers are alerted immediately via log aggregation / alerting.
 *
 * The critical_payments queue additionally enforces removeOnFail: false so
 * that exhausted financial jobs are always preserved for post-mortem audit —
 * they must never be silently deleted from Redis.
 *
 * Workers should be created in a separate process (worker.ts).
 */
export function createWorker(
  queueName: QueueName,
  processor: (job: Job) => Promise<void>,
  options?: Partial<WorkerOptions>
): Worker {
  const queueConfig = QUEUE_CONFIGS[queueName];
  const connection = createRedisConnection();
  // Use a unique key per worker in case multiple workers share the same queue name
  const connKey = `${queueName}:worker:${connectionInstances.size}`;
  connectionInstances.set(connKey, connection);

  // For the critical_payments queue, override removeOnFail so that any job
  // that exhausts all retries is preserved indefinitely in Redis for audit and
  // manual replay. WorkerOptions.removeOnFail is typed as KeepJobs (boolean is
  // not accepted, unlike per-job BaseJobOptions). `{ count: -1 }` means "keep an
  // unlimited number of failed jobs" — i.e. never auto-remove — which is the
  // exact runtime value BullMQ derives internally from the legacy boolean
  // `false` (scripts.getKeepJobs: `false || { count: -1 }`), so behavior is
  // unchanged. `{ count: 0 }` is NOT equivalent — it would mean "keep zero
  // failed jobs" and delete exhausted financial jobs (Bug W-1 fix).
  // Other queues keep their configured age-based retention.
  const removeOnFailOverride: Partial<WorkerOptions> =
    queueName === 'critical_payments' ? { removeOnFail: { count: -1 } } : {};

  const worker = new Worker(
    queueName,
    processor,
    {
      connection: connection as unknown as WorkerOptions['connection'],
      ...queueConfig.workerOptions,
      ...removeOnFailOverride,
      ...options,
    }
  );

  // DLQ monitoring: log a CRITICAL alert whenever a job exhausts all retries.
  // This fires only on the final failure (attemptsMade === job.opts.attempts).
  worker.on('failed', (job: Job | undefined, error: Error) => {
    if (!job) {
      dlqLog.error({ queue: queueName, err: error.message }, 'CRITICAL: BullMQ job failed — no job context available (possible stalled job)');
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 1;
    const isExhausted = job.attemptsMade >= maxAttempts;

    if (isExhausted) {
      dlqLog.error(
        {
          queue: queueName,
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts,
          err: error.message,
          errorStack: error.stack,
        },
        `CRITICAL: Job ${job.id} (${job.name}) in queue "${queueName}" has exhausted all ${maxAttempts} retries and moved to DLQ. Manual intervention required.`,
      );
    } else {
      // Transient failure — will be retried; log at warn level only
      dlqLog.warn(
        {
          queue: queueName,
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts,
          err: error.message,
        },
        `Job ${job.id} (${job.name}) failed attempt ${job.attemptsMade}/${maxAttempts} — will retry`,
      );
    }
  });

  return worker;
}

// ============================================================================
// HMAC PAYLOAD SIGNING (Attack 12 — Redis injection defence)
// ============================================================================

/**
 * Sign a financial job payload with HMAC-SHA256.
 * Returns a 64-character hex digest that must be stored as `_sig` in the job.
 *
 * Hard rule: Only call this for FINANCIAL jobs (critical_payments escrow events).
 */
export function signJobPayload(payload: Record<string, unknown>): string {
  const body = JSON.stringify(payload);
  return createHmac('sha256', config.queue.hmacSecret).update(body).digest('hex');
}

/**
 * Verify a financial job payload against its HMAC-SHA256 signature.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Returns true only when `signature` matches the expected HMAC of `payload`.
 */
export function verifyJobSignature(payload: Record<string, unknown>, signature: string): boolean {
  const expected = signJobPayload(payload);
  // Constant-time comparison — prevents timing side-channel
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================================
// GRACEFUL SHUTDOWN — close all tracked Redis connections
// ============================================================================

const shutdownHandler = async (signal: string) => {
  rootLogger.info({ signal }, 'queues: received shutdown signal, closing Redis connections');
  await closeAllConnections();
};

process.on('SIGTERM', () => { void shutdownHandler('SIGTERM'); });
process.on('SIGINT',  () => { void shutdownHandler('SIGINT'); });

// ============================================================================
// EXPORTS
// ============================================================================

export { Queue, Worker };
export type { QueueOptions, WorkerOptions };
