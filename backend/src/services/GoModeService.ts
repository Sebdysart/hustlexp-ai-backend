/**
 * GoModeService
 *
 * Manages a hustler's "Go Mode" — their real-time availability signal.
 *
 * Go Mode is the hustler-side equivalent of a poster posting a task:
 *   - Hustler enables Go Mode + shares GPS location
 *   - DispatchService filters candidates by go_mode=true + recent location
 *   - Location is considered "fresh" within LOCATION_FRESHNESS_MINUTES
 *
 * Columns used (added in migration 010):
 *   users.go_mode               BOOLEAN
 *   users.last_location_lat     NUMERIC(10,7)
 *   users.last_location_lng     NUMERIC(10,7)
 *   users.location_updated_at   TIMESTAMPTZ
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { logger as serviceLogger } from '../logger.js';

const log = serviceLogger.child({ service: 'GoModeService' });

/** A hustler is "online" if go_mode=true AND location updated within this window */
const LOCATION_FRESHNESS_MINUTES = 10;

export interface GoModeStatus {
  goMode: boolean;
  isOnline: boolean;
  lastLocationLat: number | null;
  lastLocationLng: number | null;
  locationUpdatedAt: Date | null;
}

export interface OnlineHustler {
  userId: string;
  trustTier: number;
  lat: number;
  lng: number;
  locationUpdatedAt: Date;
  acceptanceRate: number;
  avgResponseTimeSeconds: number | null;
  cancellationRate: number;
  preferredCategories: string[];
}

export const GoModeService = {
  /**
   * Enable or disable Go Mode for a hustler.
   * Disabling clears the online location to stop dispatch eligibility immediately.
   */
  async setGoMode(userId: string, enabled: boolean): Promise<GoModeStatus> {
    const result = await db.query<{
      go_mode: boolean;
      last_location_lat: number | null;
      last_location_lng: number | null;
      location_updated_at: Date | null;
    }>(
      `UPDATE users
          SET go_mode          = $1,
              -- Clear location timestamp on disable so we stop matching immediately
              location_updated_at = CASE WHEN $1 = FALSE THEN NULL ELSE location_updated_at END,
              updated_at        = NOW()
        WHERE id = $2
       RETURNING go_mode, last_location_lat, last_location_lng, location_updated_at`,
      [enabled, userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const row = result.rows[0];
    const isOnline = GoModeService._deriveIsOnline(row.go_mode, row.location_updated_at);

    log.info({ userId, enabled, isOnline }, 'Go Mode updated');
    return {
      goMode: row.go_mode,
      isOnline,
      lastLocationLat: row.last_location_lat,
      lastLocationLng: row.last_location_lng,
      locationUpdatedAt: row.location_updated_at,
    };
  },

  /**
   * Update a hustler's GPS location (called from iOS background location).
   * Also implicitly marks them as online if go_mode=true.
   */
  async updateLocation(
    userId: string,
    lat: number,
    lng: number
  ): Promise<GoModeStatus> {
    // Validate coordinates
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error(`Invalid coordinates: lat=${lat}, lng=${lng}`);
    }

    const result = await db.query<{
      go_mode: boolean;
      last_location_lat: number | null;
      last_location_lng: number | null;
      location_updated_at: Date | null;
    }>(
      `UPDATE users
          SET last_location_lat   = $1,
              last_location_lng   = $2,
              location_updated_at = NOW(),
              updated_at          = NOW()
        WHERE id = $3
       RETURNING go_mode, last_location_lat, last_location_lng, location_updated_at`,
      [lat, lng, userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const row = result.rows[0];
    const isOnline = GoModeService._deriveIsOnline(row.go_mode, row.location_updated_at);

    // Recalculate ETA for any active smart-dispatch claimed task
    await GoModeService._refreshETAForClaimedTask(userId, lat, lng).catch(() => {});

    return {
      goMode: row.go_mode,
      isOnline,
      lastLocationLat: row.last_location_lat,
      lastLocationLng: row.last_location_lng,
      locationUpdatedAt: row.location_updated_at,
    };
  },

  /**
   * Get the current Go Mode status for a hustler.
   */
  async getStatus(userId: string): Promise<GoModeStatus> {
    const result = await db.query<{
      go_mode: boolean;
      last_location_lat: number | null;
      last_location_lng: number | null;
      location_updated_at: Date | null;
    }>(
      `SELECT go_mode, last_location_lat, last_location_lng, location_updated_at
         FROM users
        WHERE id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const row = result.rows[0];
    const isOnline = GoModeService._deriveIsOnline(row.go_mode, row.location_updated_at);
    return {
      goMode: row.go_mode,
      isOnline,
      lastLocationLat: row.last_location_lat,
      lastLocationLng: row.last_location_lng,
      locationUpdatedAt: row.location_updated_at,
    };
  },

  /**
   * Fetch all currently online hustlers, optionally filtered by proximity.
   * "Online" = go_mode=true AND location updated within LOCATION_FRESHNESS_MINUTES.
   *
   * @param taskLat  Optional task latitude for distance-based ordering
   * @param taskLng  Optional task longitude for distance-based ordering
   * @param radiusMiles  Only return hustlers within this radius (requires taskLat/taskLng)
   */
  async getOnlineHustlers(
    taskLat?: number,
    taskLng?: number,
    radiusMiles?: number
  ): Promise<OnlineHustler[]> {
    const freshnessInterval = `${LOCATION_FRESHNESS_MINUTES} minutes`;

    let query: string;
    let params: (string | number)[];

    if (taskLat !== undefined && taskLng !== undefined && radiusMiles !== undefined) {
      // Distance-ordered query with radius filter
      // Uses the Haversine approximation in SQL (accurate enough for dispatch radii)
      query = `
        SELECT
          u.id                         AS user_id,
          u.trust_tier,
          u.last_location_lat          AS lat,
          u.last_location_lng          AS lng,
          u.location_updated_at,
          u.acceptance_rate,
          u.avg_response_time_seconds,
          u.cancellation_rate,
          COALESCE(u.preferred_categories, '{}') AS preferred_categories,
          -- Haversine distance in miles
          3958.8 * ACOS(
            LEAST(1, COS(RADIANS($1)) * COS(RADIANS(u.last_location_lat))
            * COS(RADIANS(u.last_location_lng) - RADIANS($2))
            + SIN(RADIANS($1)) * SIN(RADIANS(u.last_location_lat)))
          ) AS distance_miles
        FROM users u
        WHERE u.go_mode = TRUE
          AND u.last_location_lat IS NOT NULL
          AND u.last_location_lng IS NOT NULL
          AND u.location_updated_at > NOW() - INTERVAL '${freshnessInterval}'
          AND u.default_mode = 'worker'
          AND u.trust_hold = FALSE
          AND u.account_status = 'ACTIVE'
          AND 3958.8 * ACOS(
            LEAST(1, COS(RADIANS($1)) * COS(RADIANS(u.last_location_lat))
            * COS(RADIANS(u.last_location_lng) - RADIANS($2))
            + SIN(RADIANS($1)) * SIN(RADIANS(u.last_location_lat)))
          ) <= $3
        ORDER BY distance_miles ASC
        LIMIT 50`;
      params = [taskLat, taskLng, radiusMiles];
    } else {
      // No location filter — return all online hustlers
      query = `
        SELECT
          u.id                         AS user_id,
          u.trust_tier,
          u.last_location_lat          AS lat,
          u.last_location_lng          AS lng,
          u.location_updated_at,
          u.acceptance_rate,
          u.avg_response_time_seconds,
          u.cancellation_rate,
          COALESCE(u.preferred_categories, '{}') AS preferred_categories
        FROM users u
        WHERE u.go_mode = TRUE
          AND u.last_location_lat IS NOT NULL
          AND u.last_location_lng IS NOT NULL
          AND u.location_updated_at > NOW() - INTERVAL '${freshnessInterval}'
          AND u.default_mode = 'worker'
          AND u.trust_hold = FALSE
          AND u.account_status = 'ACTIVE'
        ORDER BY u.acceptance_rate DESC
        LIMIT 50`;
      params = [];
    }

    const result = await db.query<{
      user_id: string;
      trust_tier: number;
      lat: number;
      lng: number;
      location_updated_at: Date;
      acceptance_rate: number;
      avg_response_time_seconds: number | null;
      cancellation_rate: number;
      preferred_categories: string[];
    }>(query, params);

    return result.rows.map(row => ({
      userId: row.user_id,
      trustTier: row.trust_tier,
      lat: Number(row.lat),
      lng: Number(row.lng),
      locationUpdatedAt: row.location_updated_at,
      acceptanceRate: Number(row.acceptance_rate),
      avgResponseTimeSeconds: row.avg_response_time_seconds,
      cancellationRate: Number(row.cancellation_rate),
      preferredCategories: row.preferred_categories ?? [],
    }));
  },

  /**
   * Recalculate and persist ETA for any active smart-dispatch claimed task
   * belonging to this hustler. Called on every location update (every ~30 s).
   * Writes a `task.eta_updated` outbox event so the poster's screen refreshes.
   */
  async _refreshETAForClaimedTask(
    hustlerId: string,
    hustlerLat: number,
    hustlerLng: number
  ): Promise<void> {
    const claimedTask = await db.query<{
      id: string;
      latitude: number | null;
      longitude: number | null;
    }>(
      `SELECT id, latitude, longitude
         FROM tasks
        WHERE worker_id       = $1
          AND dispatch_state  = 'claimed'
          AND fulfillment_mode = 'smart_dispatch'
          AND state IN ('ACCEPTED', 'IN_PROGRESS')
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
        LIMIT 1`,
      [hustlerId]
    );

    if (claimedTask.rowCount === 0) return;

    const task = claimedTask.rows[0];
    const distMiles = GoModeService._haversineDistanceMiles(
      hustlerLat, hustlerLng,
      Number(task.latitude), Number(task.longitude)
    );
    const etaMinutes = Math.max(2, Math.min(Math.ceil((distMiles / 25) * 60), 120));
    const etaAt = new Date(Date.now() + etaMinutes * 60 * 1000);

    await db.query(
      `UPDATE tasks
          SET estimated_arrival_minutes = $1,
              estimated_arrival_at      = $2
        WHERE id = $3`,
      [etaMinutes, etaAt, task.id]
    );

    await writeToOutbox({
      eventType: 'task.eta_updated',
      aggregateType: 'task',
      aggregateId: task.id,
      payload: {
        taskId: task.id,
        estimatedArrivalMinutes: etaMinutes,
        estimatedArrivalAt: etaAt.toISOString(),
      },
      queueName: 'user_notifications',
      idempotencyKey: `eta_updated_${task.id}_${Math.floor(Date.now() / 30000)}`,
    });

    log.debug({ taskId: task.id, hustlerId, etaMinutes }, 'ETA refreshed');
  },

  /** Haversine distance in miles between two GPS points */
  _haversineDistanceMiles(
    lat1: number, lng1: number,
    lat2: number, lng2: number
  ): number {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /** A hustler is "online" if go_mode=true AND location was updated recently */
  _deriveIsOnline(goMode: boolean, locationUpdatedAt: Date | null): boolean {
    if (!goMode || !locationUpdatedAt) return false;
    const ageMs = Date.now() - new Date(locationUpdatedAt).getTime();
    return ageMs <= LOCATION_FRESHNESS_MINUTES * 60 * 1000;
  },
};
