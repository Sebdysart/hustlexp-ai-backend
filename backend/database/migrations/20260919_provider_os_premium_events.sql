-- New organization-owned provenance only. Never replay the historical user ledger.
CREATE TABLE provider_os_domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('CLIENT_JOINED', 'CLIENT_TASK_POSTED', 'QUOTE_ACCEPTED', 'TASK_READY')),
  organization_id UUID REFERENCES business_organizations(id) ON DELETE SET NULL,
  poster_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  relationship_id UUID REFERENCES provider_os_relationships(id) ON DELETE SET NULL,
  draft_id UUID REFERENCES task_drafts(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'skipped')),
  outcome TEXT,
  processed_at TIMESTAMPTZ
);
CREATE INDEX provider_os_domain_events_pending ON provider_os_domain_events(occurred_at) WHERE status = 'pending';

CREATE INDEX outbox_provider_os_dispatch_lease ON outbox_events(enqueued_at)
WHERE status = 'enqueued' AND left(idempotency_key, 15) = 'provider_os:v2:';

ALTER TABLE sms_outbox ADD COLUMN provider_os_event_id UUID REFERENCES provider_os_domain_events(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sms_outbox_provider_os_recipient ON sms_outbox(provider_os_event_id, user_id) WHERE provider_os_event_id IS NOT NULL;

-- Includes deliberately skipped recipients (who cannot have an sms_outbox row without a phone).
CREATE TABLE provider_os_event_recipients (
  event_id UUID NOT NULL REFERENCES provider_os_domain_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  sms_id UUID REFERENCES sms_outbox(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE FUNCTION provider_os_record_premium_event(
  kind TEXT, org UUID, poster UUID, relationship UUID, draft UUID, quote UUID, task UUID, dedupe TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE event_id UUID;
BEGIN
  INSERT INTO provider_os_domain_events(event_type, organization_id, poster_user_id, relationship_id, draft_id, quote_id, task_id, event_key)
  VALUES (kind, org, poster, relationship, draft, quote, task, dedupe)
  ON CONFLICT (event_key) DO NOTHING RETURNING id INTO event_id;
  IF event_id IS NOT NULL THEN
    INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, event_version, idempotency_key, payload, queue_name)
    VALUES ('provider_os.premium_event', 'provider_os_event', event_id, 2,
      'provider_os:v2:event:' || event_id, jsonb_build_object('eventId', event_id), 'user_notifications');
  END IF;
END;
$$;

-- AFTER triggers commit the event and outbox atomically with the canonical write.
-- No recipients, phones, external services or delivery failures participate here.
CREATE FUNCTION provider_os_capture_client_joined() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.provider_organization_id IS NOT NULL
    AND NEW.accepted_at IS NOT NULL AND NEW.accepted_by_user_id = NEW.poster_user_id THEN
    PERFORM provider_os_record_premium_event('CLIENT_JOINED', NEW.provider_organization_id,
      NEW.poster_user_id, NEW.id, NULL, NULL, NULL, 'joined:' || NEW.provider_organization_id || ':' || NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_os_client_joined AFTER INSERT ON provider_os_relationships
FOR EACH ROW EXECUTE FUNCTION provider_os_capture_client_joined();

CREATE FUNCTION provider_os_capture_task_posted() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE relation RECORD;
BEGIN
  IF NEW.poster_user_id IS NULL OR NEW.task_id IS NOT NULL OR NEW.quote_id IS NOT NULL
    OR NEW.claimed_at IS NOT NULL OR NEW.status NOT IN
      ('draft', 'anonymous_task_draft', 'contact_captured', 'account_claimed', 'quote_ready', 'quote_send_ready') THEN
    RETURN NEW;
  END IF;
  FOR relation IN
    SELECT r.id, r.provider_organization_id FROM provider_os_relationships r
    JOIN business_organizations o ON o.id = r.provider_organization_id AND o.status = 'ACTIVE' AND o.provider_enabled
    JOIN provider_os_entitlements e ON e.organization_id = o.id AND e.status = 'active'
      AND e.starts_at <= NOW() AND (e.expires_at IS NULL OR e.expires_at > NOW())
    WHERE r.poster_user_id = NEW.poster_user_id AND r.status = 'active' AND r.accepted_at IS NOT NULL
  LOOP
    PERFORM provider_os_record_premium_event('CLIENT_TASK_POSTED', relation.provider_organization_id,
      NEW.poster_user_id, relation.id, NEW.id, NULL, NULL, 'posted:' || relation.provider_organization_id || ':' || NEW.id);
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_os_task_posted AFTER INSERT ON task_drafts
FOR EACH ROW EXECUTE FUNCTION provider_os_capture_task_posted();

CREATE FUNCTION provider_os_capture_quote_selected() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE selected RECORD;
BEGIN
  IF NEW.quote_id IS NOT NULL AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    SELECT q.id, q.business_organization_id, r.id AS relationship_id INTO selected FROM quotes q
    JOIN provider_os_relationships r ON r.provider_organization_id = q.business_organization_id AND r.poster_user_id = NEW.poster_user_id
    WHERE q.id = NEW.quote_id AND q.task_draft_id = NEW.id AND q.acquisition_origin = 'provider_os' AND q.status = 'quote_send_ready';
    IF FOUND THEN
      PERFORM provider_os_record_premium_event('QUOTE_ACCEPTED', selected.business_organization_id, NEW.poster_user_id,
        selected.relationship_id, NEW.id, selected.id, NULL, 'accepted:' || selected.business_organization_id || ':' || selected.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_os_quote_selected AFTER UPDATE OF quote_id ON task_drafts
FOR EACH ROW EXECUTE FUNCTION provider_os_capture_quote_selected();

-- Payment finalization has multiple writes. SUCCEEDED is written only after
-- escrow funding/materialization/task acceptance; capturing here closes the
-- crash gap before the subsequent quotes.status update and its replay shortcut.
CREATE FUNCTION provider_os_capture_task_ready() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE paid RECORD;
BEGIN
  IF NEW.status IS DISTINCT FROM 'SUCCEEDED' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'SUCCEEDED' THEN RETURN NEW; END IF;
  END IF;
  SELECT d.id AS draft_id, d.poster_user_id, t.id AS task_id,
    q.business_organization_id, r.id AS relationship_id INTO paid
  FROM quotes q JOIN task_drafts d ON d.id = q.task_draft_id AND d.quote_id = q.id
  JOIN tasks t ON t.id = d.task_id AND t.id = NEW.task_id
  JOIN provider_os_relationships r ON r.provider_organization_id = q.business_organization_id AND r.poster_user_id = d.poster_user_id
  WHERE q.id = NEW.quote_id AND q.acquisition_origin = 'provider_os'
    AND t.business_fulfiller_organization_id = q.business_organization_id AND t.state = 'ACCEPTED';
  IF FOUND THEN
    PERFORM provider_os_record_premium_event('TASK_READY', paid.business_organization_id, paid.poster_user_id,
      paid.relationship_id, paid.draft_id, NEW.quote_id, paid.task_id, 'ready:' || paid.business_organization_id || ':' || NEW.quote_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_os_task_ready AFTER INSERT OR UPDATE OF status ON quote_payments
FOR EACH ROW EXECUTE FUNCTION provider_os_capture_task_ready();

-- Historical records stay intact. Old undelivered messages can never enter v2.
UPDATE sms_outbox SET status = 'suppressed', error_message = 'legacy_provider_os_provenance', updated_at = NOW()
WHERE left(idempotency_key, 12) = 'provider_os:' AND provider_os_event_id IS NULL AND twilio_sid IS NULL
  AND status IN ('pending', 'failed', 'sending');
