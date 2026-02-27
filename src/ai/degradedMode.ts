/**
 * AI Degraded Mode — cascade failure fallback.
 *
 * When AI_DEGRADED_MODE=true OR all circuit breakers are open, instead of
 * attempting an inline AI call we:
 *   1. Enqueue the request to an in-process queue (BullMQ-ready structure).
 *   2. Return a { status: 'queued', jobId, message } payload immediately.
 *   3. The caller returns HTTP 202 Accepted to the client.
 *
 * Design notes:
 * - The queue is in-process (Map + incrementing ID) so that the src/ layer
 *   has no hard Redis dependency at boot time.  In production the jobs can be
 *   forwarded to BullMQ by calling enqueueToBullMQ() once Redis is available.
 * - The module is intentionally free of side-effects at import time so tests
 *   can vi.mock() individual helpers without complex setup.
 */

import { env } from '../config/env.js';
import { areAllCircuitsOpen } from '../utils/reliability.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedAIJob {
  jobId: string;
  userId: string;
  message: string;
  mode: string;
  enqueuedAt: number;
  expiresAt: number;
}

export interface DegradedModeResult {
  status: 'queued';
  jobId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// In-process queue (lightweight, no Redis required)
// ---------------------------------------------------------------------------

const _queue = new Map<string, QueuedAIJob>();
let _jobCounter = 0;

// Parse AI_MAX_QUEUE_WAIT_MS once at module level with a NaN guard so we
// avoid repeated parseInt() calls and the subtle risk of parseInt('', 10) → NaN.
const _maxWaitMs = (() => {
  const parsed = parseInt(env.AI_MAX_QUEUE_WAIT_MS || '5000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

/**
 * Generate a unique, sortable job ID.
 * Format: ai-{timestamp}-{counter}
 */
function generateJobId(): string {
  return `ai-${Date.now()}-${++_jobCounter}`;
}

/**
 * Evict jobs whose expiresAt timestamp has passed.
 * Called at the start of enqueueAIRequest to bound queue growth without
 * needing a setInterval.
 */
function evictExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of _queue) {
    if (job.expiresAt <= now) {
      _queue.delete(id);
    }
  }
}

/**
 * Add a request to the in-process queue.
 * Returns the queued job record.
 */
export function enqueueAIRequest(
  userId: string,
  message: string,
  mode: string,
): QueuedAIJob {
  evictExpiredJobs(); // Clean up expired jobs before adding a new one
  const job: QueuedAIJob = {
    jobId: generateJobId(),
    userId,
    message,
    mode,
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + _maxWaitMs,
  };
  _queue.set(job.jobId, job);
  return job;
}

/**
 * Retrieve a queued job by ID (for status polling if needed).
 */
export function getQueuedJob(jobId: string): QueuedAIJob | undefined {
  return _queue.get(jobId);
}

/**
 * Remove a job from the queue (after processing or expiry).
 */
export function dequeueJob(jobId: string): void {
  _queue.delete(jobId);
}

/**
 * Current depth of the in-process queue (useful for health reporting).
 */
export function getQueueDepth(): number {
  return _queue.size;
}

// ---------------------------------------------------------------------------
// Degraded-mode guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the system should operate in degraded mode:
 *  - AI_DEGRADED_MODE env var is set to 'true', OR
 *  - All AI circuit breakers are OPEN (total cascade failure)
 */
export function isDegradedMode(): boolean {
  if (env.AI_DEGRADED_MODE === 'true') return true;
  return areAllCircuitsOpen();
}

/**
 * Queue an AI request and return the 202-ready payload.
 * Call this from route handlers when isDegradedMode() is true.
 */
export function handleDegradedRequest(
  userId: string,
  message: string,
  mode: string,
): DegradedModeResult {
  const job = enqueueAIRequest(userId, message, mode);
  return {
    status: 'queued',
    jobId: job.jobId,
    message: 'AI is temporarily unavailable. Your request has been queued and will be processed when service is restored.',
  };
}
