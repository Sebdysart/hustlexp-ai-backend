import { randomUUID } from 'node:crypto';
import { analyticsQuery, AnalyticsCapacityError } from './database.js';
import { buildIdentity } from '../../buildIdentity.js';
import { BUSINESS_EVENTS, productPropertiesSchema, sanitizeAnalyticsRoute, sanitizeAnalyticsReferrer, type BehaviorEvent, type ProductEventName } from './contract.js';

export const analyticsEnvironment = process.env.ANALYTICS_ENVIRONMENT || buildIdentity.environment;
export const internalAnalyticsUsers = () => (process.env.ANALYTICS_INTERNAL_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
export interface AnalyticsActor { userId?: string; role?: string; internal?: boolean }
export interface BusinessAnalyticsEvent {
  event_name: ProductEventName; deduplication_key?: string; user_id?: string;
  session_id?: string; anonymous_id?: string; correlation_id?: string; causation_id?: string; action_attempt_id?: string;
  task_draft_id?: string; task_id?: string; quote_id?: string; proposal_id?: string; business_organization_id?: string;
  category?: string; intake_profile?: string; evidence_type?: 'observed' | 'reported' | 'derived';
  outcome?: 'requested' | 'committed' | 'failed'; reason_code?: string;
  occurred_at?: string;
  properties?: Record<string, unknown>;
}
type HealthCounter = 'accepted' | 'duplicate' | 'invalid' | 'rate_limited' | 'storage_failed' | 'consent_skipped' | 'capacity_dropped';
const healthCounters = new Map<HealthCounter, number>();
let healthTimer: ReturnType<typeof setTimeout> | undefined;
// Coalesce counters, including rejected requests, so invalid traffic cannot cause a write per request.
export async function recordAnalyticsHealth(counter: HealthCounter, count = 1): Promise<void> {
  healthCounters.set(counter, (healthCounters.get(counter) || 0) + count);
  if (!healthTimer) {
    healthTimer = setTimeout(() => { healthTimer = undefined; void flushHealth(); }, 10000);
    healthTimer.unref();
  }
}
async function flushHealth(): Promise<void> {
  const counts = [...healthCounters]; healthCounters.clear();
  try {
    for (const [counter, count] of counts) {
    await analyticsQuery(`INSERT INTO analytics_ingestion_health(hour,environment,counter,count)
      VALUES(date_trunc('hour',now()),$1,$2,$3) ON CONFLICT(hour,environment,counter)
      DO UPDATE SET count=analytics_ingestion_health.count+EXCLUDED.count`, [analyticsEnvironment, counter, count]);
    }
  } catch { /* Telemetry availability cannot affect the caller; outage counters are best effort. */ }
}

async function insertProductEvent(event: BehaviorEvent | BusinessAnalyticsEvent, source: 'browser' | 'backend', actor: AnalyticsActor) {
  try {
    if (actor.userId) {
      const consent = await analyticsQuery<{ granted: boolean }>(
        `SELECT granted FROM user_consents WHERE user_id=$1 AND consent_type='analytics'`, [actor.userId]);
      // Preserve the existing explicit opt-out contract; fail closed on consent lookup failure.
      if (consent.rows.some((row) => !row.granted)) {
        void recordAnalyticsHealth('consent_skipped');
        return { accepted: false, reason: 'consent' };
      }
    }
    const properties = productPropertiesSchema.parse(event.properties || {});
    const browser = source === 'browser' ? event as BehaviorEvent : undefined;
    const business = source === 'backend' ? event as BusinessAnalyticsEvent : undefined;
    // Canonical test flags and operator roles are derived on the server, never trusted from callers.
    const trust = await analyticsQuery<{ internal: boolean; test: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM admin_roles WHERE user_id=$1) AS internal,
      EXISTS(SELECT 1 FROM quotes q WHERE (q.id=$2 OR q.task_id=$3
        OR q.id IN (SELECT d.quote_id FROM task_drafts d WHERE d.id=$4 OR d.task_id=$3)
        OR q.id IN (SELECT p.quote_id FROM business_task_proposals p WHERE p.id=$5))
        AND (q.is_test OR q.environment<>'PRODUCTION')) AS test`,
      [actor.userId || null, event.quote_id || null, event.task_id || null, event.task_draft_id || null, event.proposal_id || null]);
    const sessionId = event.session_id || randomUUID();
    const now = new Date();
    const occurredAt = new Date(event.occurred_at || now.toISOString());
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > now.getTime() + 300000 || (browser && occurredAt.getTime() < now.getTime() - 86400000)) {
      void recordAnalyticsHealth('invalid');
      return { accepted: false, reason: 'timestamp' };
    }
    const dedupe = browser ? `browser:${browser.anonymous_id}:${browser.id}`
      : business?.deduplication_key ? `backend:${event.event_name}:${business.deduplication_key}` : null;
    const internal = Boolean(actor.internal || trust.rows[0]?.internal || trust.rows[0]?.test || (actor.userId && internalAnalyticsUsers().includes(actor.userId)));
    const result = await analyticsQuery(`INSERT INTO analytics_events (
      event_type,event_category,event_version,source,environment,evidence_type,
      user_id,session_id,device_id,anonymous_id,actor_role,is_internal,
      correlation_id,causation_id,action_attempt_id,outcome,reason_code,
      route,referrer,device_type,browser,viewport_width,
      utm_source,utm_medium,utm_campaign,utm_content,utm_term,
      task_draft_id,task_id,quote_id,proposal_id,business_organization_id,task_category,intake_profile,
      build_id,properties,platform,event_timestamp,ingested_at,deduplication_key)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35::jsonb,'web',$36,now(),$37)
      ON CONFLICT(deduplication_key) DO NOTHING RETURNING id`, [
      event.event_name, source === 'browser' ? 'user_action' : 'system_event', source, analyticsEnvironment,
      business?.evidence_type || 'observed', actor.userId || null, sessionId, event.anonymous_id || sessionId,
      event.anonymous_id || null, actor.role || (trust.rows[0]?.internal ? 'operator' : null), internal,
      event.correlation_id || null, event.causation_id || null, event.action_attempt_id || null,
      business?.outcome || null, event.reason_code || null,
      sanitizeAnalyticsRoute(browser?.route), sanitizeAnalyticsReferrer(browser?.referrer), browser?.device_type || null,
      browser?.browser || null, browser?.viewport_width ?? null,
      browser?.attribution?.utm_source || null, browser?.attribution?.utm_medium || null,
      browser?.attribution?.utm_campaign || null, browser?.attribution?.utm_content || null, browser?.attribution?.utm_term || null,
      event.task_draft_id || null, event.task_id || null, event.quote_id || null, event.proposal_id || null,
      event.business_organization_id || null, event.category || null, event.intake_profile || null,
      browser?.build_id || (source === 'backend' ? buildIdentity.revision : null), JSON.stringify(properties), occurredAt, dedupe,
    ]);
    const accepted = result.rows.length > 0;
    void recordAnalyticsHealth(accepted ? 'accepted' : 'duplicate');
    return { accepted, duplicate: !accepted };
  } catch (error) {
    if (error instanceof AnalyticsCapacityError) {
      void recordAnalyticsHealth('capacity_dropped');
      return { accepted: false, reason: 'capacity' };
    }
    void recordAnalyticsHealth('storage_failed');
    return { accepted: false, reason: 'unavailable' };
  }
}

export function collectBehaviorEvent(event: BehaviorEvent, actor: AnalyticsActor) {
  return insertProductEvent(event, 'browser', actor);
}
/** Call only AFTER commit. Best effort; no caller must await delivery to complete business work. */
export async function trackProductEvent(event: BusinessAnalyticsEvent): Promise<void> {
  try {
    if (!(BUSINESS_EVENTS as readonly string[]).includes(event.event_name)) return;
    await insertProductEvent(event, 'backend', { userId: event.user_id });
  } catch { /* Never fail a business action. */ }
}

/** Reuse committed outbox evidence without adding jobs or changing delivery/acknowledgement. */
export async function observeAnalyticsOutbox(event: { id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown>; created_at: Date }): Promise<void> {
  try {
    if (event.event_type === 'task.progress_updated' && event.payload.to === 'WORKING') {
      const actor = event.payload.actor as { userId?: unknown } | undefined;
      await trackProductEvent({ event_name: 'task_started', deduplication_key: event.aggregate_id,
        user_id: typeof actor?.userId === 'string' ? actor.userId : undefined,
        task_id: event.aggregate_id, correlation_id: event.aggregate_id, causation_id: event.id,
        occurred_at: new Date(event.created_at).toISOString(), outcome: 'committed' });
    } else if (event.event_type === 'escrow.completion_release_requested' && typeof event.payload.task_id === 'string') {
      // A release request alone is not completion evidence: verify canonical completed state.
      const task = await analyticsQuery<{ completed_at: Date; poster_id: string }>(`SELECT completed_at,poster_id FROM tasks WHERE id=$1 AND state='COMPLETED' AND completed_at IS NOT NULL`, [event.payload.task_id]);
      if (task.rows[0]) await trackProductEvent({ event_name: 'task_completed', deduplication_key: event.payload.task_id,
        user_id: task.rows[0].poster_id,
        task_id: event.payload.task_id, correlation_id: event.payload.task_id, causation_id: event.id,
        occurred_at: new Date(task.rows[0].completed_at).toISOString(), outcome: 'committed' });
    }
  } catch { /* Observing telemetry must never alter outbox delivery. */ }
}
