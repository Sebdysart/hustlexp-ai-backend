/**
 * DispatchService v1
 *
 * Determines which hustlers to ping for a given task + wave.
 *
 * Wave definitions:
 *   Wave 1 — top 3 online hustlers scored by DispatchScore v1, within 5 miles
 *   Wave 2 — top 10 online hustlers within 15 miles (broadens radius)
 *   Wave 3 — broadcast to all eligible (up to 30), regardless of go_mode
 *
 * DispatchScore v1 weights (derived from MatchmakerAI factors):
 *   proximity        0.35  (most important — time-to-arrive matters)
 *   reliability      0.25  (completion rate, acceptance rate)
 *   trustTier        0.20
 *   responsiveness   0.15  (avg response time, cancel rate)
 *   skillMatch       0.05  (category preference)
 *
 * For Wave 3, MatchmakerAIService.rankCandidates() is called to produce the
 * AI-ranked list rather than deterministic scoring.
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { GoModeService, type OnlineHustler } from './GoModeService.js';
import { MatchmakerAIService } from './MatchmakerAIService.js';
import { PlanService } from './PlanService.js';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from './InstantTrustConfig.js';
import { logger as serviceLogger } from '../logger.js';

const log = serviceLogger.child({ service: 'DispatchService' });

// Wave configuration
const WAVE_CONFIG = {
  1: { maxHustlers: 3, radiusMiles: 5, requireOnline: true },
  2: { maxHustlers: 10, radiusMiles: 15, requireOnline: true },
  3: { maxHustlers: 30, radiusMiles: 999, requireOnline: false },
} as const;

export type WaveNumber = 1 | 2 | 3;

export interface TaskDispatchInfo {
  id: string;
  title: string;
  description: string;
  category: string | null;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  sensitive: boolean;
  price: number;
  locationLat: number | null;
  locationLng: number | null;
  location: string | null;
  requirements: string | null;
  fulfillmentMode: string;
  dispatchState: string;
}

export interface DispatchCandidate {
  userId: string;
  score: number;
  waveNumber: WaveNumber;
}

export const DispatchService = {
  /**
   * Get the ordered list of hustlers to ping for a given wave.
   * Returns an empty array if no eligible candidates exist.
   */
  async getCandidatesForWave(
    task: TaskDispatchInfo,
    waveNumber: WaveNumber
  ): Promise<DispatchCandidate[]> {
    const waveConf = WAVE_CONFIG[waveNumber];

    // Determine minimum trust tier
    const minTier = task.sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
    const riskTier = task.riskLevel === 'HIGH' || task.riskLevel === 'IN_HOME' ? 3 : 1;
    const effectiveMinTier = Math.max(minTier, riskTier);

    let candidates: DispatchCandidate[] = [];

    if (waveConf.requireOnline) {
      // Waves 1 & 2: online hustlers only, filtered by radius
      const online = task.locationLat !== null && task.locationLng !== null
        ? await GoModeService.getOnlineHustlers(
            task.locationLat,
            task.locationLng,
            waveConf.radiusMiles
          )
        : await GoModeService.getOnlineHustlers();

      // Filter by trust tier
      const eligible = online.filter(h => h.trustTier >= effectiveMinTier);

      // Score and sort
      const scored = eligible.map(h => ({
        hustler: h,
        score: DispatchService._computeDispatchScore(
          h,
          task,
          waveConf.radiusMiles
        ),
      }));
      scored.sort((a, b) => b.score - a.score);

      candidates = scored.slice(0, waveConf.maxHustlers).map(({ hustler, score }) => ({
        userId: hustler.userId,
        score,
        waveNumber,
      }));
    } else {
      // Wave 3: broadcast — use MatchmakerAI on all eligible hustlers
      candidates = await DispatchService._getWave3Candidates(task, effectiveMinTier);
    }

    // Filter by plan eligibility (async — done last to minimise DB calls)
    const planFiltered: DispatchCandidate[] = [];
    for (const candidate of candidates) {
      const planCheck = await PlanService.canAcceptTaskWithRisk(
        candidate.userId,
        task.riskLevel
      );
      if (planCheck.allowed) {
        planFiltered.push(candidate);
      }
    }

    log.info(
      { taskId: task.id, waveNumber, found: planFiltered.length },
      'Dispatch candidates resolved'
    );
    return planFiltered;
  },

  /**
   * Enqueue outbox events to ping a list of hustlers for a task.
   * Records dispatch_events rows for the audit trail.
   */
  async dispatchToHustlers(
    taskId: string,
    candidates: DispatchCandidate[],
    waveNumber: WaveNumber,
    taskLocation: string | null
  ): Promise<void> {
    if (candidates.length === 0) {
      log.info({ taskId, waveNumber }, 'No candidates — skipping dispatch');
      return;
    }

    await db.transaction(async (query) => {
      // Update task dispatch state
      await query(
        `UPDATE tasks
            SET dispatch_state    = $1,
                wave_number       = $2,
                last_dispatched_at = NOW(),
                updated_at        = NOW()
          WHERE id = $3`,
        [`wave_${waveNumber}`, waveNumber, taskId]
      );

      // Write dispatch_events audit rows
      for (const candidate of candidates) {
        await query(
          `INSERT INTO dispatch_events
             (task_id, hustler_id, event_type, wave_number, dispatch_score)
           VALUES ($1, $2, 'wave_started', $3, $4)`,
          [taskId, candidate.userId, waveNumber, candidate.score]
        );
      }

      // Enqueue ping notifications via outbox (transactional)
      for (const candidate of candidates) {
        await writeToOutbox(
          {
            eventType: 'task.dispatch_ping',
            aggregateType: 'task',
            aggregateId: taskId,
            eventVersion: waveNumber,
            idempotencyKey: `task.dispatch_ping:${taskId}:${candidate.userId}:wave${waveNumber}`,
            payload: {
              taskId,
              hustlerId: candidate.userId,
              waveNumber,
              dispatchScore: candidate.score,
              location: taskLocation,
            },
            queueName: 'user_notifications',
          },
          query
        );

        // Also enqueue push notification
        await writeToOutbox(
          {
            eventType: 'task.instant_available',
            aggregateType: 'task',
            aggregateId: taskId,
            idempotencyKey: `task.instant_available:${taskId}:${candidate.userId}:wave${waveNumber}`,
            payload: {
              taskId,
              hustlerId: candidate.userId,
              waveNumber,
              location: taskLocation,
            },
            queueName: 'user_notifications',
          },
          query
        );
      }
    });

    log.info({ taskId, waveNumber, pinged: candidates.length }, 'Dispatch pings enqueued');
  },

  /**
   * Record a ping event (viewed, accepted, declined, expired) in dispatch_events.
   */
  async recordPingEvent(
    taskId: string,
    hustlerId: string,
    eventType: 'ping_viewed' | 'ping_accepted' | 'ping_declined' | 'ping_expired' | 'claimed',
    waveNumber?: number
  ): Promise<void> {
    await db.query(
      `INSERT INTO dispatch_events (task_id, hustler_id, event_type, wave_number)
       VALUES ($1, $2, $3, $4)`,
      [taskId, hustlerId, eventType, waveNumber ?? null]
    );
  },

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * DispatchScore v1 — deterministic scoring for waves 1 & 2.
   *
   * Weights:
   *   proximity     0.35
   *   reliability   0.25
   *   trustTier     0.20
   *   responsiveness 0.15
   *   skillMatch    0.05
   */
  _computeDispatchScore(
    hustler: OnlineHustler,
    task: TaskDispatchInfo,
    maxRadiusMiles: number
  ): number {
    // Proximity (0–1): linear decay from 0 mi → 1.0, maxRadiusMiles → 0
    const distanceScore = task.locationLat !== null && task.locationLng !== null
      ? Math.max(0, 1 - DispatchService._haversineDistance(
          task.locationLat,
          task.locationLng,
          hustler.lat,
          hustler.lng
        ) / maxRadiusMiles)
      : 0.5; // unknown location: neutral score

    // Reliability: weighted avg of acceptance_rate + completion inferred from cancellation_rate
    const reliabilityScore =
      0.6 * hustler.acceptanceRate +
      0.4 * (1 - hustler.cancellationRate);

    // Trust tier: normalize to [0,1] (max tier = 4)
    const trustScore = Math.min(hustler.trustTier / 4, 1);

    // Responsiveness: fast responders score higher
    // avg_response_time_seconds: null = unknown (0.5), 0–30s = great (0.9+), >300s = poor (0.1)
    let responsivenessScore = 0.5;
    if (hustler.avgResponseTimeSeconds !== null) {
      const t = hustler.avgResponseTimeSeconds;
      responsivenessScore = t <= 30 ? 1.0 : t <= 60 ? 0.85 : t <= 120 ? 0.7 : t <= 300 ? 0.4 : 0.1;
    }

    // Skill match: preferred category alignment
    const skillScore =
      task.category !== null && hustler.preferredCategories.includes(task.category)
        ? 1.0
        : 0.4;

    const score =
      0.35 * distanceScore +
      0.25 * reliabilityScore +
      0.20 * trustScore +
      0.15 * responsivenessScore +
      0.05 * skillScore;

    return Math.max(0, Math.min(1, score));
  },

  /** Haversine distance in miles between two lat/lng points */
  _haversineDistance(
    lat1: number, lng1: number,
    lat2: number, lng2: number
  ): number {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * Wave 3 candidates: DB-filtered eligibility + MatchmakerAI ranking.
   */
  async _getWave3Candidates(
    task: TaskDispatchInfo,
    effectiveMinTier: number
  ): Promise<DispatchCandidate[]> {
    // Fetch all eligible hustlers (broad filter, no go_mode requirement)
    const result = await db.query<{
      id: string;
      trust_tier: number;
      last_location_lat: number | null;
      last_location_lng: number | null;
      acceptance_rate: number;
      cancellation_rate: number;
      avg_response_time_seconds: number | null;
    }>(
      `SELECT u.id, u.trust_tier, u.last_location_lat, u.last_location_lng,
              u.acceptance_rate, u.cancellation_rate, u.avg_response_time_seconds
         FROM users u
        WHERE u.default_mode = 'worker'
          AND u.trust_hold = FALSE
          AND u.account_status = 'active'
          AND u.trust_tier >= $1
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.worker_id = u.id
               AND t.instant_mode = TRUE
               AND t.state IN ('MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED')
          )
        ORDER BY u.acceptance_rate DESC
        LIMIT 50`,
      [effectiveMinTier]
    );

    const hustlers = result.rows;
    if (hustlers.length === 0) return [];

    // Build MatchmakerAI candidate inputs
    const aiCandidates = hustlers.map(h => ({
      userId: h.id,
      trustTier: h.trust_tier,
      completedTasks: 0, // not fetched in this query — AI uses other factors
      completionRate: 1 - Number(h.cancellation_rate),
      isAvailable: true,
      location:
        h.last_location_lat !== null && h.last_location_lng !== null
          ? { latitude: Number(h.last_location_lat), longitude: Number(h.last_location_lng) }
          : undefined,
    }));

    const aiTask = {
      id: task.id,
      title: task.title,
      description: task.description,
      category: task.category ?? undefined,
      location: task.location ?? undefined,
      price: task.price,
      requirements: task.requirements ?? undefined,
    };

    const rankResult = await MatchmakerAIService.rankCandidates(aiTask, aiCandidates);
    const ranked = rankResult.success ? rankResult.data : [];

    return ranked.slice(0, WAVE_CONFIG[3].maxHustlers).map(r => ({
      userId: r.userId,
      score: r.matchScore,
      waveNumber: 3 as const,
    }));
  },

  // ── Claim Conversion ────────────────────────────────────────────────────────

  /**
   * Convert a soft hold into a real task assignment.
   *
   * The UPDATE is atomic: it only succeeds if the soft hold is still held by
   * this hustler and has not expired. If two hustlers race, only one wins.
   *
   * After a successful claim:
   *   1. ETA is calculated from the hustler's last known GPS to the task location.
   *   2. ETA is stored on the task row for the poster to read.
   *   3. A `task.dispatch_claimed` outbox event is written so the poster
   *      receives a real-time SSE update.
   */
  async confirmClaim(taskId: string, hustlerId: string): Promise<{
    taskId: string;
    estimatedArrivalMinutes: number | null;
    estimatedArrivalAt: Date | null;
  }> {
    // Atomically convert soft_hold_active → claimed
    const claimResult = await db.query<{
      latitude: number | null;
      longitude: number | null;
    }>(
      `UPDATE tasks
          SET state                = 'ACCEPTED',
              worker_id            = $1,
              dispatch_state       = 'claimed',
              soft_hold_hustler_id = NULL,
              soft_hold_expires_at = NULL,
              last_dispatched_at   = NOW()
        WHERE id = $2
          AND soft_hold_hustler_id = $1
          AND soft_hold_expires_at > NOW()
          AND state IN ('OPEN', 'MATCHING')
          AND worker_id IS NULL
        RETURNING latitude, longitude`,
      [hustlerId, taskId]
    );

    if (claimResult.rowCount === 0) {
      throw new Error('CONFLICT: Soft hold expired or task already claimed by another hustler');
    }

    const taskLat = claimResult.rows[0].latitude !== null ? Number(claimResult.rows[0].latitude) : null;
    const taskLng = claimResult.rows[0].longitude !== null ? Number(claimResult.rows[0].longitude) : null;

    // Record claimed event in dispatch_events
    await DispatchService.recordPingEvent(taskId, hustlerId, 'claimed');

    // Calculate ETA from hustler's last GPS → task location
    let etaMinutes: number | null = null;
    let etaAt: Date | null = null;

    if (taskLat !== null && taskLng !== null) {
      const hustlerLoc = await db.query<{
        last_location_lat: number | null;
        last_location_lng: number | null;
      }>(
        `SELECT last_location_lat, last_location_lng FROM users WHERE id = $1`,
        [hustlerId]
      );

      const hLat = hustlerLoc.rows[0]?.last_location_lat;
      const hLng = hustlerLoc.rows[0]?.last_location_lng;

      if (hLat !== null && hLat !== undefined && hLng !== null && hLng !== undefined) {
        const distMiles = DispatchService._haversineDistance(
          Number(hLat), Number(hLng), taskLat, taskLng
        );
        // Estimate at 25 mph urban average, clamped to [2, 120] min
        etaMinutes = Math.max(2, Math.min(Math.ceil((distMiles / 25) * 60), 120));
        etaAt = new Date(Date.now() + etaMinutes * 60 * 1000);

        await db.query(
          `UPDATE tasks
              SET estimated_arrival_minutes = $1,
                  estimated_arrival_at      = $2
            WHERE id = $3`,
          [etaMinutes, etaAt, taskId]
        );
      }
    }

    // Outbox event → poster sees real-time SSE update
    await writeToOutbox({
      eventType: 'task.dispatch_claimed',
      aggregateType: 'task',
      aggregateId: taskId,
      payload: {
        taskId,
        hustlerId,
        estimatedArrivalMinutes: etaMinutes,
        estimatedArrivalAt: etaAt?.toISOString() ?? null,
      },
      queueName: 'user_notifications',
      idempotencyKey: `dispatch_claimed_${taskId}`,
    });

    log.info({ taskId, hustlerId, etaMinutes }, 'Task claimed via Smart Dispatch');
    return { taskId, estimatedArrivalMinutes: etaMinutes, estimatedArrivalAt: etaAt };
  },
};
