import { z } from 'zod';
import { analyticsQuery } from './database.js';
import { analyticsEnvironment, internalAnalyticsUsers } from './store.js';

import { analyticsRangeSchema } from './contract.js';
export { analyticsRangeSchema } from './contract.js';

export const metricDefinitions = {
  version: 3,
  intake: 'Distinct intake_attempt_id starting in [start,end), observed through the report time. Completion means preview reached. Repeat views/edits do not create additional completions.',
  dropoff: 'Derived: last viewed question on an uncompleted attempt with no activity for 30 minutes. This is an inactivity indicator, not a confirmed abandonment reason. Newer attempts remain in progress.',
  funnel: 'Same first-start cohort. Only one committed draft with consistent authenticated/anonymous identities and canonical ownership is linked. Conflicting/multiple/missing links remain unresolved. Stages are independently observed as of report time; conditional rates use the intersection with the previous stage, not division of independent counts. Immature cohorts are not final conversion.',
  marketplace: 'Draft-created cohort in [start,end); current canonical state. Paid includes subsequent refunds. Full/partial refund counts use successful Tilled refund ledger amounts when present, otherwise legacy escrow states. These are counts, not revenue adjustments. Values are customer quote cents, never revenue. Selection/approval latency is omitted: no reliable canonical customer-acceptance timestamp is available; quote_send_ready_at is mutable operational state.',
  approval: 'Dated customer approval: task_drafts.quote_id plus scheduled_service_date. Quote generation can set quote_id without customer approval; those legacy/generated links are shown separately, not counted as approvals.',
  support: 'Thread-created cohort in [start,end); current statuses and time from creation to current resolved_at. Reopened threads count under their current status.',
  traffic: 'Browser telemetry in the selected server environment; internal/admin/configured IDs excluded by default. Canonical quote.is_test and quote.environment exclude known test quotes. Unmarked demo accounts cannot be reliably identified.',
};

// All SQL remains behind AnalyticsService. Fixed queries only; no client-authored SQL.
export async function getProductAnalytics(input: z.infer<typeof analyticsRangeSchema>) {
  const asOf = new Date();
  const end = input.end ? new Date(Math.min(Date.parse(input.end), asOf.getTime())) : asOf;
  const start = input.start ? new Date(input.start) : new Date(end.getTime() - input.days * 86400000);
  const args = [start, end, analyticsEnvironment, input.includeInternal, input.build || null, internalAnalyticsUsers(), asOf];
  const eventCTE = `WITH events AS (
    SELECT * FROM analytics_events e WHERE e.event_version=1 AND e.environment=$3
      AND e.event_timestamp >= $1 AND e.event_timestamp <= $7
      AND ($4::boolean OR (NOT e.is_internal AND NOT (COALESCE(e.user_id::text,'')=ANY($6::text[]))
        AND NOT EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=e.user_id)))
      AND NOT EXISTS(SELECT 1 FROM quotes q WHERE (q.id=e.quote_id OR q.task_id=e.task_id
        OR q.id IN (SELECT d.quote_id FROM task_drafts d WHERE d.id=e.task_draft_id OR d.task_id=e.task_id)
        OR q.id IN (SELECT p.quote_id FROM business_task_proposals p WHERE p.id=e.proposal_id))
        AND (q.is_test OR q.environment<>'PRODUCTION'))
  ), first_starts AS (
    SELECT DISTINCT ON (properties->>'intake_attempt_id') properties->>'intake_attempt_id' AS attempt,
      session_id,anonymous_id,user_id,device_type,utm_source,utm_campaign,build_id,event_timestamp AS started_at
    FROM events WHERE source='browser' AND event_type='task_intake_started'
      AND properties->>'intake_attempt_id' IS NOT NULL AND event_timestamp < $2
      AND NOT EXISTS(SELECT 1 FROM analytics_events older WHERE older.event_version=1 AND older.environment=$3
        AND older.source='browser' AND older.event_type='task_intake_started'
        AND older.properties->>'intake_attempt_id'=events.properties->>'intake_attempt_id' AND older.event_timestamp<$1)
      ORDER BY properties->>'intake_attempt_id',event_timestamp,id
  ), starts AS (
    SELECT * FROM first_starts WHERE ($5::text IS NULL OR build_id=$5)
  ), identity_evidence AS (
    -- Inspect all same-environment evidence, even excluded internal/test rows:
    -- conflicting identities must not disappear just because a report filters them.
    SELECT s.attempt, count(DISTINCT owner.user_id) AS user_count,
      count(DISTINCT e.anonymous_id) AS anonymous_count,
      array_agg(DISTINCT e.task_draft_id) FILTER(WHERE e.source='backend' AND e.event_type='task_draft_created'
        AND e.outcome='committed' AND e.task_draft_id IS NOT NULL) AS draft_ids,
      count(*) FILTER(WHERE e.source='backend' AND e.event_type='task_draft_created' AND e.outcome='committed'
        AND (d.id IS NULL OR e.user_id IS NULL OR d.poster_user_id IS NULL OR e.user_id IS DISTINCT FROM d.poster_user_id)) AS invalid_drafts
    FROM starts s JOIN analytics_events e ON e.properties->>'intake_attempt_id'=s.attempt
      AND e.event_version=1 AND e.environment=$3 AND e.event_timestamp<=$7
    LEFT JOIN task_drafts d ON e.source='backend' AND e.event_type='task_draft_created'
      AND e.outcome='committed' AND d.id=e.task_draft_id
    CROSS JOIN LATERAL (VALUES(e.user_id),(d.poster_user_id)) owner(user_id)
    GROUP BY s.attempt
  ), activity AS (
    SELECT s.*,
      MIN(e.event_timestamp) FILTER(WHERE e.event_type='task_intake_completed' AND e.source='browser') AS completed_at,
      MAX(e.event_timestamp) AS last_activity,
      COUNT(DISTINCT e.session_id) FILTER(WHERE e.source='browser')::int AS sessions
    FROM starts s LEFT JOIN events e ON e.properties->>'intake_attempt_id'=s.attempt
    GROUP BY s.attempt,s.session_id,s.anonymous_id,s.user_id,s.device_type,s.utm_source,s.utm_campaign,s.build_id,s.started_at
  ), linkage AS (
    SELECT a.*,i.user_count,i.anonymous_count,
      CASE WHEN i.user_count>1 THEN 'conflicting_users' WHEN i.anonymous_count>1 THEN 'conflicting_anonymous'
        WHEN cardinality(i.draft_ids)>1 THEN 'multiple_drafts' WHEN i.invalid_drafts>0 THEN 'invalid_draft_owner'
        WHEN cardinality(i.draft_ids)=1 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.source='backend'
          AND e.event_type='task_draft_created' AND e.outcome='committed' AND e.task_draft_id=i.draft_ids[1]
          AND e.properties->>'intake_attempt_id'=a.attempt) THEN 'excluded_draft'
        WHEN cardinality(i.draft_ids)=1 THEN 'resolved' ELSE 'missing_draft' END AS linkage_state,
      i.draft_ids
    FROM activity a JOIN identity_evidence i ON i.attempt=a.attempt
  ), attempts AS (
    SELECT l.*, CASE WHEN l.linkage_state='resolved' THEN l.draft_ids[1] ELSE NULL END AS draft_id,
      CASE WHEN l.user_count<=1 AND l.anonymous_count<=1 THEN state.task_category ELSE NULL END AS category,
      CASE WHEN l.user_count<=1 AND l.anonymous_count<=1 AND (
        (state.task_category='cleaning' AND state.intake_profile IN ('cleaning_indoor','cleaning_surface')) OR
        (state.task_category='auto' AND state.intake_profile IN ('auto_repair','auto_cleaning')))
        THEN state.intake_profile ELSE NULL END AS profile
    FROM linkage l LEFT JOIN LATERAL (
      SELECT e.task_category,e.intake_profile FROM events e
      WHERE e.properties->>'intake_attempt_id'=l.attempt AND e.task_category IS NOT NULL
      ORDER BY e.event_timestamp DESC,e.ingested_at DESC,e.id DESC LIMIT 1
    ) state ON true
  )`;
  // JSON output keeps number/null types explicit and avoids pg BIGINT string surprises.
  const query = (sql: string) => async () => {
    try { return { available: true as const, rows: (await analyticsQuery<{ data: Record<string, unknown> }>(sql, args)).rows.map((r) => r.data) }; }
    catch { return { available: false as const, rows: [] as Record<string, unknown>[] }; }
  };
  const queries = [
    query(`${eventCTE} SELECT jsonb_build_object('sessions',count(DISTINCT session_id),'known_users',count(DISTINCT user_id),
      'events',count(*),'latest_event',max(ingested_at)) AS data FROM events WHERE source='browser' AND event_timestamp<$2 AND ($5::text IS NULL OR build_id=$5)`),
    query(`${eventCTE} SELECT jsonb_build_object('dimension',dimension,'value',COALESCE(value,'unknown'),'starts',count(*),
      'completed',count(completed_at),'in_progress',count(*) FILTER(WHERE completed_at IS NULL AND last_activity>$7::timestamptz-interval '30 minutes'),
      'inactive',count(*) FILTER(WHERE completed_at IS NULL AND last_activity<=$7::timestamptz-interval '30 minutes'),
      'returned',count(*) FILTER(WHERE sessions>1),'mean_seconds',avg(extract(epoch FROM completed_at-started_at)),
      'drafts',count(draft_id),'paid',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM task_drafts d JOIN quotes q ON q.id=d.quote_id
        JOIN quote_payments p ON p.quote_id=q.id WHERE d.id=attempts.draft_id AND NOT q.is_test AND q.environment='PRODUCTION' AND p.status IN ('SUCCEEDED','REFUNDED')))) AS data
      FROM attempts CROSS JOIN LATERAL (VALUES ('all','all'),('category',category),('profile',profile),('device',device_type),
        ('source',utm_source),('campaign',utm_campaign),('build',build_id)) dimensions(dimension,value) GROUP BY dimension,value ORDER BY dimension,count(*) DESC`),
    query(`${eventCTE}, question_events AS (
      SELECT e.*,a.attempt,a.completed_at,a.last_activity FROM events e JOIN attempts a ON e.properties->>'intake_attempt_id'=a.attempt
      WHERE a.user_count<=1 AND a.anonymous_count<=1 AND e.source='browser'
        AND e.event_type IN ('task_intake_question_viewed','task_intake_question_answered','task_intake_question_skipped')
    ), last_views AS (SELECT DISTINCT ON(attempt) attempt,task_category,intake_profile,properties->>'question_key' AS key FROM question_events
      WHERE event_type='task_intake_question_viewed' ORDER BY attempt,event_timestamp DESC,id DESC)
    SELECT jsonb_build_object('category',COALESCE(e.task_category,'unknown'),'profile',COALESCE(e.intake_profile,'unknown'),
      'question',e.properties->>'question_key','importance',e.properties->>'question_importance',
      'seen',count(DISTINCT e.attempt) FILTER(WHERE event_type='task_intake_question_viewed'),
      'answered',count(DISTINCT e.attempt) FILTER(WHERE event_type='task_intake_question_answered'),
      'skipped',count(DISTINCT e.attempt) FILTER(WHERE event_type='task_intake_question_skipped'),
      'edits',count(*) FILTER(WHERE e.properties->>'edited'='true'),
      'inactive_last_view',count(DISTINCT e.attempt) FILTER(WHERE e.completed_at IS NULL AND e.last_activity<=$7::timestamptz-interval '30 minutes'
        AND l.key=e.properties->>'question_key' AND l.task_category IS NOT DISTINCT FROM e.task_category AND l.intake_profile IS NOT DISTINCT FROM e.intake_profile)) AS data
      FROM question_events e LEFT JOIN last_views l ON l.attempt=e.attempt GROUP BY e.task_category,e.intake_profile,e.properties->>'question_key',e.properties->>'question_importance' ORDER BY count(*) DESC`),
    query(`${eventCTE}, stages AS (
      SELECT a.linkage_state,d.id IS NOT NULL AS draft_created,
        EXISTS(SELECT 1 FROM quotes q WHERE q.task_draft_id=d.id AND NOT q.is_test AND q.environment='PRODUCTION') AS quote_created,
        (d.scheduled_service_date IS NOT NULL AND EXISTS(SELECT 1 FROM quotes q WHERE q.id=d.quote_id AND NOT q.is_test AND q.environment='PRODUCTION')) AS quote_approved,
        EXISTS(SELECT 1 FROM quotes q JOIN quote_payments p ON p.quote_id=q.id WHERE q.id=d.quote_id AND NOT q.is_test AND q.environment='PRODUCTION' AND p.status IN ('SUCCEEDED','REFUNDED')) AS paid,
        COALESCE(t.state='COMPLETED',false) AS completed
      FROM attempts a LEFT JOIN task_drafts d ON d.id=a.draft_id LEFT JOIN tasks t ON t.id=d.task_id
    ) SELECT jsonb_build_object('started',count(*),
      'draft_created',count(*) FILTER(WHERE draft_created),'quote_created',count(*) FILTER(WHERE quote_created),
      'quote_approved',count(*) FILTER(WHERE quote_approved),'paid',count(*) FILTER(WHERE paid),'completed',count(*) FILTER(WHERE completed),
      'draft_created_from_previous',count(*) FILTER(WHERE draft_created),
      'quote_created_from_previous',count(*) FILTER(WHERE draft_created AND quote_created),
      'quote_approved_from_previous',count(*) FILTER(WHERE quote_created AND quote_approved),
      'paid_from_previous',count(*) FILTER(WHERE quote_approved AND paid),
      'completed_from_previous',count(*) FILTER(WHERE paid AND completed),
      'unlinked',count(*) FILTER(WHERE linkage_state<>'resolved'),
      'linkage',COALESCE((SELECT jsonb_object_agg(linkage_state,n) FROM (SELECT linkage_state,count(*) n FROM stages GROUP BY linkage_state) counts),'{}'::jsonb)) AS data FROM stages`),
    query(`WITH eligible AS (SELECT d.* FROM task_drafts d WHERE d.created_at >= $1 AND d.created_at < $2
      AND ($4::boolean OR (NOT (COALESCE(d.poster_user_id::text,'')=ANY($6::text[])) AND NOT EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=d.poster_user_id)))
      AND NOT EXISTS(SELECT 1 FROM quotes q WHERE q.id=d.quote_id AND (q.is_test OR q.environment<>'PRODUCTION')))
      SELECT jsonb_build_object('drafts',count(*),'selected_quotes',count(d.quote_id) FILTER(WHERE d.scheduled_service_date IS NOT NULL),
      'approval_unknown',count(d.quote_id) FILTER(WHERE d.scheduled_service_date IS NULL),
      'quoted_drafts',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM quotes q WHERE q.task_draft_id=d.id AND NOT q.is_test AND q.environment='PRODUCTION')),
      'paid_tasks',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM quote_payments p WHERE p.quote_id=d.quote_id AND p.status IN ('SUCCEEDED','REFUNDED'))),
      'fully_refunded_quotes',count(DISTINCT d.quote_id) FILTER(WHERE EXISTS(SELECT 1 FROM quote_payments p
        WHERE p.quote_id=d.quote_id AND p.status IN ('SUCCEEDED','REFUNDED') AND
        (CASE WHEN EXISTS(SELECT 1 FROM quote_payment_refunds r WHERE r.quote_payment_id=p.id AND r.status='SUCCEEDED')
          THEN COALESCE((SELECT SUM(r.amount_cents) FROM quote_payment_refunds r WHERE r.quote_payment_id=p.id AND r.status='SUCCEEDED'),0)>=p.amount_cents
          ELSE EXISTS(SELECT 1 FROM escrows e WHERE e.task_id=p.task_id AND e.state='REFUNDED') END))),
      'partially_refunded_quotes',count(DISTINCT d.quote_id) FILTER(WHERE EXISTS(SELECT 1 FROM quote_payments p
        WHERE p.quote_id=d.quote_id AND p.status IN ('SUCCEEDED','REFUNDED') AND
        (CASE WHEN EXISTS(SELECT 1 FROM quote_payment_refunds r WHERE r.quote_payment_id=p.id AND r.status='SUCCEEDED')
          THEN COALESCE((SELECT SUM(r.amount_cents) FROM quote_payment_refunds r WHERE r.quote_payment_id=p.id AND r.status='SUCCEEDED'),0)>0
            AND COALESCE((SELECT SUM(r.amount_cents) FROM quote_payment_refunds r WHERE r.quote_payment_id=p.id AND r.status='SUCCEEDED'),0)<p.amount_cents
          ELSE EXISTS(SELECT 1 FROM escrows e WHERE e.task_id=p.task_id AND e.state='REFUND_PARTIAL') END))),
      'assigned_tasks',count(*) FILTER(WHERE t.worker_id IS NOT NULL OR t.state IN ('ACCEPTED','PROOF_SUBMITTED','COMPLETED')),
      'completed_tasks',count(*) FILTER(WHERE t.state='COMPLETED'),
      'mean_selected_quote_cents',avg(qv.total_cents) FILTER(WHERE d.scheduled_service_date IS NOT NULL),
      'mean_draft_to_completion_seconds',avg(extract(epoch FROM t.completed_at-d.created_at)),
      'unquoted',count(*) FILTER(WHERE d.quote_id IS NULL), 'source','canonical draft cohort', 'environment',$3::text,
      'build_filter_applied',false,'as_of',$7::timestamptz) AS data
      FROM eligible d LEFT JOIN quotes q ON q.id=d.quote_id LEFT JOIN quote_versions qv ON qv.id=q.active_version_id LEFT JOIN tasks t ON t.id=d.task_id
      WHERE ($5::text IS NULL OR $5::text IS NOT NULL)`),
    query(`SELECT jsonb_build_object('status',status,'threads',count(*),'mean_resolution_seconds',avg(extract(epoch FROM resolved_at-created_at)),
      'environment',$3::text,'as_of',$7::timestamptz,'build_filter_applied',false) AS data
      FROM support_threads st WHERE created_at >= $1 AND created_at < $2
      AND ($4::boolean OR (NOT (st.opened_by_user_id::text=ANY($6::text[])) AND NOT EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=st.opened_by_user_id)))
      AND NOT EXISTS(SELECT 1 FROM quotes q WHERE (q.id=st.quote_id OR q.task_id=st.task_id
        OR q.id IN (SELECT d.quote_id FROM task_drafts d WHERE d.id=st.task_draft_id)
        OR q.id IN (SELECT p.quote_id FROM business_task_proposals p WHERE p.id=st.proposal_id))
        AND (q.is_test OR q.environment<>'PRODUCTION'))
      AND ($5::text IS NULL OR $5::text IS NOT NULL) GROUP BY status`),
    query(`SELECT jsonb_build_object('counters',COALESCE((SELECT jsonb_object_agg(counter,n) FROM
      (SELECT counter,sum(count) AS n FROM analytics_ingestion_health WHERE environment=$3 AND hour >= date_trunc('hour',$1::timestamptz) AND hour<$2 GROUP BY counter) h),'{}'::jsonb),
      'received',count(*),'last_received',max(ingested_at),'mean_ingestion_delay_seconds',avg(extract(epoch FROM ingested_at-event_timestamp)),
      'missing_draft_reference',count(*) FILTER(WHERE event_type='task_draft_created' AND task_draft_id IS NULL),
      'authoritative_draft_events',count(DISTINCT task_draft_id) FILTER(WHERE source='backend' AND event_type='task_draft_created'),
      'environment',$3::text,'as_of',$7::timestamptz) AS data FROM analytics_events
      WHERE event_version=1 AND environment=$3 AND ingested_at >= $1 AND ingested_at < $2
      AND ($4::boolean OR (NOT is_internal AND NOT (COALESCE(user_id::text,'')=ANY($6::text[]))
        AND NOT EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=analytics_events.user_id)))
      AND ($5::text IS NULL OR build_id=$5)`),
    query(`${eventCTE} SELECT jsonb_build_object('event',event_type,'count',count(*),'source',source) AS data FROM events
      WHERE event_timestamp<$2 AND event_type IN ('provider_os_opened','client_invite_created','client_onboarded','client_task_viewed','provider_os_quote_submitted')
      AND ($5::text IS NULL OR build_id=$5) GROUP BY event_type,source`),
    query(`WITH bounds AS (SELECT $1::timestamptz AS start,$2::timestamptz AS finish,$3::text AS environment,
      $4::boolean AS include_internal,$5::text AS build,$6::text[] AS internal_ids,$7::timestamptz AS observed_at),
      eligible AS (SELECT d.* FROM task_drafts d,bounds b WHERE d.created_at>=b.start AND d.created_at<b.finish
        AND (b.include_internal OR (NOT(COALESCE(d.poster_user_id::text,'')=ANY(b.internal_ids))
          AND NOT EXISTS(SELECT 1 FROM admin_roles a WHERE a.user_id=d.poster_user_id)))
        AND NOT EXISTS(SELECT 1 FROM quotes q WHERE q.id=d.quote_id AND (q.is_test OR q.environment<>'PRODUCTION'))),
      facts AS (SELECT 'task_draft_created'::text AS event,id::text AS entity FROM eligible
        UNION ALL SELECT 'quote_approved',quote_id::text FROM eligible WHERE quote_id IS NOT NULL AND scheduled_service_date IS NOT NULL
        UNION ALL SELECT 'payment_succeeded',p.quote_id::text FROM eligible d JOIN quote_payments p ON p.quote_id=d.quote_id WHERE p.status IN ('SUCCEEDED','REFUNDED'))
      SELECT jsonb_build_object('event',f.event,'canonical',count(DISTINCT f.entity),
        'instrumented',count(DISTINCT f.entity) FILTER(WHERE EXISTS(SELECT 1 FROM analytics_events e,bounds b
          WHERE e.event_version=1 AND e.source='backend' AND e.environment=b.environment AND e.event_type=f.event
          AND e.event_timestamp<=b.observed_at AND CASE WHEN f.event='task_draft_created' THEN e.task_draft_id::text ELSE e.quote_id::text END=f.entity)),
        'source','canonical draft cohort matched to backend telemetry; build filter not applied') AS data FROM facts f GROUP BY f.event`),
    query(`${eventCTE} SELECT jsonb_build_object('event',event_type,'reason',COALESCE(reason_code,'unknown'),
      'observations',count(*),'sessions',count(DISTINCT session_id)) AS data FROM events
      WHERE event_timestamp<$2 AND source='browser' AND event_type IN ('validation_failed','action_request_failed','upload_failed','draft_recovered','flow_exited','flow_error_observed')
      AND ($5::text IS NULL OR build_id=$5) GROUP BY event_type,reason_code`),
  ];
  // Sequential per report; the shared DB budget also bounds concurrent reports.
  const sections = [];
  for (const execute of queries) sections.push(await execute());
  const [overview, intake, questions, funnel, marketplace, support, health, provider, coverage, friction] = sections;
  return { version: metricDefinitions.version, start: start.toISOString(), end: end.toISOString(), asOf: asOf.toISOString(),
    environment: analyticsEnvironment, includeInternal: input.includeInternal, build: input.build || null,
    definitions: metricDefinitions, overview, intake, questions, funnel, marketplace, support, health, provider, coverage, friction };
}
