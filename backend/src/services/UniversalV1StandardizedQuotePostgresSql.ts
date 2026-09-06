export const readinessStateProjection = `
  NOT EXISTS (
    SELECT 1
      FROM public.task_draft_payment_method_readiness_facts successor
     WHERE successor.supersedes_readiness_fact_id = readiness.id
  ) AS readiness_chain_head,
  readiness.expires_at > clock_timestamp() AS readiness_unexpired,
  EXISTS (
    SELECT 1
      FROM public.task_draft_standardized_quote_versions quote
      JOIN public.task_drafts draft
        ON draft.id = quote.task_draft_id
      JOIN public.users actor
        ON actor.id = draft.poster_user_id
      JOIN public.task_routing_decisions route
        ON route.id = draft.active_routing_decision_id
       AND route.id = quote.routing_decision_id
       AND route.task_draft_id = draft.id
       AND route.decision_version = quote.routing_decision_version
      JOIN public.universal_v1_service_cell_authorities cell
        ON cell.id = quote.service_cell_authority_id
       AND cell.id = route.service_cell_authority_id
       AND cell.authority_version = quote.service_cell_authority_version
      JOIN public.universal_v1_relationship_origins origin
        ON origin.id = quote.relationship_origin_id
       AND origin.task_draft_id = draft.id
       AND origin.origin_version = quote.relationship_origin_version
     WHERE quote.id = readiness.quote_version_id
       AND quote.task_draft_id = readiness.task_draft_id
       AND draft.universal_contract_version = 1
       AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
       AND draft.status = 'account_claimed'
       AND draft.poster_user_id = readiness.prepared_by_user_id
       AND draft.task_id IS NULL
       AND actor.default_mode = 'poster'
       AND actor.account_status = 'ACTIVE'
       AND actor.is_minor IS FALSE
       AND COALESCE(actor.is_banned, FALSE) IS FALSE
       AND route.outcome = 'FULFILLMENT_CANDIDATE'
       AND route.policy_version = 'universal-v1-intake-1.2.0'
       AND route.category_snapshot = quote.work_category_code
       AND route.service_cell_snapshot = quote.region_code
       AND cell.authority_environment = quote.environment_class
       AND cell.routing_availability = 'ACTIVE'
       AND cell.is_test IS TRUE
       AND cell.authority_kind = 'SYNTHETIC_FIXTURE'
       AND cell.effective_from <= clock_timestamp()
       AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_service_cell_authorities successor
          WHERE successor.supersedes_authority_id = cell.id
       )
       AND origin.origin_kind = 'MARKETPLACE'
       AND origin.routing_state = 'ROUTING_READY'
       AND cardinality(origin.hold_reason_codes) = 0
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_relationship_origins successor
          WHERE successor.supersedes_origin_id = origin.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_draft_standardized_quote_versions successor
          WHERE successor.supersedes_quote_version_id = quote.id
       )
  ) AS routing_current`;
