-- HX/OS external-liquidity bridge: privacy-safe share capabilities terminate in
-- the canonical task application and assignment workflow. Raw capability tokens
-- are never stored; source, terms, selection, and completion evidence is durable.

CREATE TABLE IF NOT EXISTS task_external_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  created_by UUID NOT NULL REFERENCES users(id),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  source_channel TEXT NOT NULL CHECK (source_channel IN (
    'nextdoor','facebook','whatsapp','email','text','copy','other'
  )),
  link_kind TEXT NOT NULL DEFAULT 'OPEN_SHARE'
    CHECK (link_kind IN ('OPEN_SHARE','DIRECT_INVITE')),
  scope_hash CHAR(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  payout_cents INTEGER NOT NULL CHECK (payout_cents > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_task_external_share_active
  ON task_external_share_links(task_id, link_kind, source_channel, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS task_direct_invite_claims (
  share_link_id UUID PRIMARY KEY REFERENCES task_external_share_links(id),
  claimed_by_user_id UUID NOT NULL REFERENCES users(id),
  eligibility_policy_version TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_external_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id UUID NOT NULL REFERENCES task_external_share_links(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  -- The application table predates the canonical schema bundle in this branch.
  -- The runtime transaction writes this UUID from the canonical application row.
  application_id UUID NOT NULL UNIQUE,
  hustler_id UUID NOT NULL REFERENCES users(id),
  source_channel TEXT NOT NULL CHECK (source_channel IN (
    'nextdoor','facebook','whatsapp','email','text','copy','other'
  )),
  scope_hash CHAR(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  payout_cents INTEGER NOT NULL CHECK (payout_cents > 0),
  availability_start TIMESTAMPTZ NOT NULL,
  availability_end TIMESTAMPTZ NOT NULL,
  terms_hash CHAR(64) NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
  eligibility_policy_version TEXT NOT NULL,
  eligibility_evidence JSONB NOT NULL,
  offer_kind TEXT NOT NULL DEFAULT 'OPEN_OFFER'
    CHECK (offer_kind IN ('OPEN_OFFER','DIRECT_ACCEPTANCE')),
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','SELECTED','REJECTED','WITHDRAWN','EXPIRED')),
  selected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (share_link_id, hustler_id),
  CHECK (availability_end > availability_start),
  CHECK ((status = 'SELECTED') = (selected_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_task_external_offers_task_status
  ON task_external_offers(task_id, status, created_at);

CREATE TABLE IF NOT EXISTS task_external_bridge_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id UUID NOT NULL REFERENCES task_external_share_links(id),
  offer_id UUID REFERENCES task_external_offers(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'SHARE_CREATED','DIRECT_INVITE_CREATED','DIRECT_INVITE_CLAIMED',
    'OFFER_SUBMITTED','SCOPE_ACCEPTED','OFFER_SELECTED','TASK_COMPLETED'
  )),
  actor_id UUID REFERENCES users(id),
  source_channel TEXT NOT NULL CHECK (source_channel IN (
    'nextdoor','facebook','whatsapp','email','text','copy','other'
  )),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_external_share_created_event
  ON task_external_bridge_events(share_link_id)
  WHERE event_type IN ('SHARE_CREATED','DIRECT_INVITE_CREATED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_direct_invite_claimed_event
  ON task_external_bridge_events(share_link_id)
  WHERE event_type = 'DIRECT_INVITE_CLAIMED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_external_offer_submitted_event
  ON task_external_bridge_events(offer_id)
  WHERE event_type IN ('OFFER_SUBMITTED','SCOPE_ACCEPTED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_external_offer_selected_event
  ON task_external_bridge_events(offer_id)
  WHERE event_type = 'OFFER_SELECTED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_external_completed_event
  ON task_external_bridge_events(task_id, share_link_id)
  WHERE event_type = 'TASK_COMPLETED';

CREATE OR REPLACE FUNCTION deny_task_external_bridge_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_external_bridge_events is append-only' USING ERRCODE = 'HX801';
END;
$$;

DROP TRIGGER IF EXISTS task_external_bridge_events_append_only ON task_external_bridge_events;
CREATE TRIGGER task_external_bridge_events_append_only
  BEFORE UPDATE OR DELETE ON task_external_bridge_events
  FOR EACH ROW EXECUTE FUNCTION deny_task_external_bridge_event_mutation();

CREATE OR REPLACE FUNCTION deny_task_direct_invite_claim_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_direct_invite_claims is append-only' USING ERRCODE = 'HX801';
END;
$$;

DROP TRIGGER IF EXISTS task_direct_invite_claims_append_only ON task_direct_invite_claims;
CREATE TRIGGER task_direct_invite_claims_append_only
  BEFORE UPDATE OR DELETE ON task_direct_invite_claims
  FOR EACH ROW EXECUTE FUNCTION deny_task_direct_invite_claim_mutation();

CREATE OR REPLACE FUNCTION enforce_task_external_share_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.source_channel IS DISTINCT FROM OLD.source_channel
     OR NEW.link_kind IS DISTINCT FROM OLD.link_kind
     OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
     OR NEW.payout_cents IS DISTINCT FROM OLD.payout_cents
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'external task share snapshot is immutable' USING ERRCODE = 'HX001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_external_share_immutable ON task_external_share_links;
CREATE TRIGGER task_external_share_immutable
  BEFORE UPDATE ON task_external_share_links
  FOR EACH ROW EXECUTE FUNCTION enforce_task_external_share_immutability();

CREATE OR REPLACE FUNCTION enforce_task_external_offer_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.share_link_id IS DISTINCT FROM OLD.share_link_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.hustler_id IS DISTINCT FROM OLD.hustler_id
     OR NEW.source_channel IS DISTINCT FROM OLD.source_channel
     OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
     OR NEW.payout_cents IS DISTINCT FROM OLD.payout_cents
     OR NEW.availability_start IS DISTINCT FROM OLD.availability_start
     OR NEW.availability_end IS DISTINCT FROM OLD.availability_end
     OR NEW.terms_hash IS DISTINCT FROM OLD.terms_hash
     OR NEW.eligibility_policy_version IS DISTINCT FROM OLD.eligibility_policy_version
     OR NEW.eligibility_evidence IS DISTINCT FROM OLD.eligibility_evidence
     OR NEW.offer_kind IS DISTINCT FROM OLD.offer_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'external task offer terms are immutable' USING ERRCODE = 'HX001';
  END IF;
  IF OLD.status <> 'SUBMITTED' OR NEW.status NOT IN ('SELECTED','REJECTED','WITHDRAWN','EXPIRED') THEN
    RAISE EXCEPTION 'invalid external task offer transition' USING ERRCODE = 'HX001';
  END IF;
  IF (NEW.status = 'SELECTED') <> (NEW.selected_at IS NOT NULL) THEN
    RAISE EXCEPTION 'selected external offer requires selected_at' USING ERRCODE = 'HX001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_external_offer_immutable ON task_external_offers;
CREATE TRIGGER task_external_offer_immutable
  BEFORE UPDATE ON task_external_offers
  FOR EACH ROW EXECUTE FUNCTION enforce_task_external_offer_immutability();

CREATE OR REPLACE FUNCTION sync_task_external_offer_from_application()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer task_external_offers%ROWTYPE;
  v_status TEXT;
  v_required_tier INTEGER;
  v_task RECORD;
  v_user RECORD;
  v_link RECORD;
  v_claim RECORD;
BEGIN
  v_status := CASE NEW.status
    WHEN 'accepted' THEN 'SELECTED'
    WHEN 'rejected' THEN 'REJECTED'
    WHEN 'counter_rejected' THEN 'REJECTED'
    WHEN 'withdrawn' THEN 'WITHDRAWN'
    WHEN 'expired' THEN 'EXPIRED'
    ELSE NULL
  END;
  IF v_status IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_offer
    FROM task_external_offers
   WHERE application_id = NEW.id AND status = 'SUBMITTED';
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_status = 'SELECTED' THEN
    SELECT state, scope_hash, hustler_payout_cents, risk_level, trust_tier_required
      INTO v_task FROM tasks WHERE id = v_offer.task_id;
    SELECT COALESCE(is_verified, false) AS is_verified,
           COALESCE(trust_hold, false) AS trust_hold, trust_tier
      INTO v_user FROM users WHERE id = v_offer.hustler_id;
    SELECT scope_hash, payout_cents, link_kind
      INTO v_link FROM task_external_share_links WHERE id = v_offer.share_link_id;
    SELECT claimed_by_user_id
      INTO v_claim FROM task_direct_invite_claims WHERE share_link_id = v_offer.share_link_id;
    v_required_tier := GREATEST(
      COALESCE(v_task.trust_tier_required, 1),
      CASE v_task.risk_level WHEN 'LOW' THEN 2 WHEN 'MEDIUM' THEN 2 WHEN 'HIGH' THEN 3 ELSE 999 END
    );
    IF v_task.state <> 'OPEN'
       OR NOT v_user.is_verified
       OR v_user.trust_hold
       OR v_user.trust_tier < v_required_tier
       OR v_link.scope_hash IS DISTINCT FROM v_task.scope_hash
       OR v_link.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents
       OR v_offer.scope_hash IS DISTINCT FROM v_task.scope_hash
       OR v_offer.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents
       OR (v_offer.offer_kind = 'DIRECT_ACCEPTANCE' AND (
         v_link.link_kind IS DISTINCT FROM 'DIRECT_INVITE'
         OR v_claim.claimed_by_user_id IS DISTINCT FROM v_offer.hustler_id
       )) THEN
      RAISE EXCEPTION 'external provider is no longer eligible for this task offer'
        USING ERRCODE = 'HX001';
    END IF;
  END IF;

  UPDATE task_external_offers
     SET status = v_status,
         selected_at = CASE WHEN v_status = 'SELECTED' THEN NOW() ELSE NULL END
   WHERE id = v_offer.id AND status = 'SUBMITTED'
   RETURNING * INTO v_offer;

  IF FOUND AND v_status = 'SELECTED' THEN
    INSERT INTO task_external_bridge_events
      (share_link_id, offer_id, task_id, event_type, actor_id, source_channel, payload_hash)
    VALUES
      (v_offer.share_link_id, v_offer.id, v_offer.task_id, 'OFFER_SELECTED', NEW.hustler_id,
       v_offer.source_channel, v_offer.terms_hash)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.task_applications') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS task_external_offer_application_sync ON task_applications';
    EXECUTE 'CREATE TRIGGER task_external_offer_application_sync
      AFTER UPDATE OF status ON task_applications
      FOR EACH ROW EXECUTE FUNCTION sync_task_external_offer_from_application()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION record_external_task_completion_attribution()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer task_external_offers%ROWTYPE;
BEGIN
  IF OLD.state IS DISTINCT FROM 'COMPLETED' AND NEW.state = 'COMPLETED' THEN
    SELECT * INTO v_offer
      FROM task_external_offers
     WHERE task_id = NEW.id AND status = 'SELECTED'
     ORDER BY selected_at DESC LIMIT 1;
    IF FOUND THEN
      INSERT INTO task_external_bridge_events
        (share_link_id, offer_id, task_id, event_type, actor_id, source_channel, payload_hash)
      VALUES
        (v_offer.share_link_id, v_offer.id, v_offer.task_id, 'TASK_COMPLETED', NEW.worker_id,
         v_offer.source_channel, v_offer.terms_hash)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_external_completion_attribution ON tasks;
CREATE TRIGGER tasks_external_completion_attribution
  AFTER UPDATE OF state ON tasks
  FOR EACH ROW EXECUTE FUNCTION record_external_task_completion_attribution();

REVOKE ALL ON task_external_share_links FROM PUBLIC;
REVOKE ALL ON task_direct_invite_claims FROM PUBLIC;
REVOKE ALL ON task_external_offers FROM PUBLIC;
REVOKE ALL ON task_external_bridge_events FROM PUBLIC;

COMMENT ON TABLE task_external_share_links IS
  'Hash-only, expiring open-share or one-claim direct-invite capabilities bound to immutable task scope and provider payout.';
COMMENT ON TABLE task_direct_invite_claims IS
  'Append-only binding from one direct provider invitation to the first currently eligible verified Hustler who accepts its scope.';
COMMENT ON TABLE task_external_offers IS
  'Structured external availability offers bound to canonical task applications and verified eligibility evidence.';
COMMENT ON TABLE task_external_bridge_events IS
  'Append-only external-source attribution from share creation through selection and on-platform completion.';
