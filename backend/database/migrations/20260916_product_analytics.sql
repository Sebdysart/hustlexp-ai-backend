-- Additive evolution of the existing analytics store. Legacy events remain identifiable
-- by event_version=0 and source=legacy; never mix them into the V1 product metrics.
-- Fail before any V1 DDL. Do not invent values or convert legacy identity/times.
DO $analytics_preflight$
DECLARE
  baseline REGCLASS := to_regclass('analytics_events');
  mismatches TEXT;
BEGIN
  IF baseline IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid=baseline AND relkind IN ('r','p')
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000',
      MESSAGE='Product Analytics V1 prerequisite failed: analytics_events must be an existing table on the migration search_path.',
      HINT='Inspect the target database/schema and docs/analytics-v1.md. Provision or reconcile the constitutional/launch analytics baseline before retrying; do not drop legacy rows.';
  END IF;

  SELECT string_agg(
    expected.name || ': expected ' || expected.type_name ||
    CASE WHEN expected.min_length IS NOT NULL THEN ' (text or varchar length >= ' || expected.min_length || ')' ELSE '' END ||
    ', found ' || CASE WHEN a.attname IS NULL THEN 'missing' ELSE format_type(a.atttypid,a.atttypmod) END,
    '; ' ORDER BY expected.name
  ) INTO mismatches
  FROM (VALUES
    ('id','uuid',NULL::integer),
    ('event_type','text',100),
    ('event_category','text',50),
    ('user_id','uuid',NULL::integer),
    ('session_id','uuid',NULL::integer),
    ('device_id','uuid',NULL::integer),
    ('task_id','uuid',NULL::integer),
    ('task_category','text',50),
    ('properties','jsonb',NULL::integer),
    ('platform','text',20),
    ('event_timestamp','timestamp with time zone',NULL::integer),
    ('ingested_at','timestamp with time zone',NULL::integer)
  ) expected(name,type_name,min_length)
  LEFT JOIN pg_attribute a ON a.attrelid=baseline AND a.attname=expected.name
    AND a.attnum>0 AND NOT a.attisdropped
  WHERE a.attname IS NULL OR NOT (
    CASE WHEN expected.type_name='text' THEN
      a.atttypid='text'::regtype OR (a.atttypid='varchar'::regtype
        AND (a.atttypmod=-1 OR a.atttypmod-4>=expected.min_length))
    ELSE a.atttypid=expected.type_name::regtype END
  );

  IF mismatches IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000',
      MESSAGE='Product Analytics V1 prerequisite failed: incompatible analytics_events baseline: ' || mismatches,
      HINT='Inspect column definitions against constitutional-schema.sql / launch-schema.sql and docs/analytics-v1.md. The minimal 005 legacy table is incompatible. Use a separately reviewed data-preserving reconciliation, then retry; no V1 changes have been applied by this migration.';
  END IF;

  -- V1 INSERT omits id and depends on the baseline UUID default.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=baseline AND attname='id' AND atthasdef) THEN
    RAISE EXCEPTION USING ERRCODE='55000',
      MESSAGE='Product Analytics V1 prerequisite failed: analytics_events.id needs its baseline UUID-generating default.',
      HINT='Review and restore the canonical UUID default without rewriting existing IDs, then retry. See docs/analytics-v1.md.';
  END IF;
END;
$analytics_preflight$;

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS event_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS evidence_type TEXT NOT NULL DEFAULT 'observed' CHECK (evidence_type IN ('observed','reported','derived')),
  ADD COLUMN IF NOT EXISTS anonymous_id UUID,
  ADD COLUMN IF NOT EXISTS actor_role TEXT,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS causation_id UUID,
  ADD COLUMN IF NOT EXISTS action_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS route TEXT,
  ADD COLUMN IF NOT EXISTS referrer TEXT,
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS browser TEXT,
  ADD COLUMN IF NOT EXISTS viewport_width INTEGER,
  ADD COLUMN IF NOT EXISTS utm_source TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_content TEXT,
  ADD COLUMN IF NOT EXISTS utm_term TEXT,
  ADD COLUMN IF NOT EXISTS task_draft_id UUID,
  ADD COLUMN IF NOT EXISTS quote_id UUID,
  ADD COLUMN IF NOT EXISTS proposal_id UUID,
  ADD COLUMN IF NOT EXISTS business_organization_id UUID,
  ADD COLUMN IF NOT EXISTS intake_profile TEXT,
  ADD COLUMN IF NOT EXISTS build_id TEXT,
  ADD COLUMN IF NOT EXISTS deduplication_key TEXT;
-- event_type/event_timestamp/ingested_at are the existing event_name/occurred_at/received_at.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_deduplication_idx ON analytics_events(deduplication_key);
CREATE INDEX IF NOT EXISTS analytics_anonymous_idx ON analytics_events(anonymous_id,event_timestamp) WHERE anonymous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_draft_idx ON analytics_events(task_draft_id,event_timestamp) WHERE task_draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_business_idx ON analytics_events(business_organization_id,event_timestamp) WHERE business_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_correlation_idx ON analytics_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_product_window_idx ON analytics_events(environment,event_timestamp) WHERE event_version=1;
CREATE INDEX IF NOT EXISTS analytics_intake_attempt_idx ON analytics_events((properties->>'intake_attempt_id'),event_timestamp) WHERE event_version=1 AND properties->>'intake_attempt_id' IS NOT NULL;
-- Health contains counters only, never invalid payloads, IPs or rejected values.
CREATE TABLE IF NOT EXISTS analytics_ingestion_health (
  hour TIMESTAMPTZ NOT NULL, environment TEXT NOT NULL, counter TEXT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(hour,environment,counter)
);
COMMENT ON TABLE analytics_events IS 'Append-only application telemetry; canonical business tables remain authoritative. Privacy erasure remains supported by existing GDPR processes.';
