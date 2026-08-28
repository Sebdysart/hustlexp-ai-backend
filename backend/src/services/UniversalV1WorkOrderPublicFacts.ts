import { db, type QueryFn } from '../db.js';
import type { HoldContext, ProviderInterestContext, WorkOrderContext } from './UniversalV1WorkOrderContracts.js';

export class PostgresUniversalV1WorkOrderPublicFactReader {
  constructor(private readonly query: QueryFn = db.query.bind(db)) {}

  async interest(actor: string, taskId: string): Promise<ProviderInterestContext | null> {
    const result = await this.query<ProviderInterestContext>(`
      SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,
             r.id routing_decision_id,e.provider_user_id,e.provider_organization_id,e.provider_class,
             e.trade_credential_id,e.id predecessor_eligibility_id,
             e.decision_version predecessor_eligibility_version,e.valid_until predecessor_valid_until
      FROM tasks t JOIN task_drafts d ON d.task_id=t.id
      JOIN task_scope_versions s ON s.id=t.active_scope_version_id
      JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id
      JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id AND m.scope_version_id=s.id
      JOIN provider_estimate_submissions p ON p.id=m.provider_estimate_submission_id
      JOIN task_provider_eligibility_decisions e ON e.task_draft_id=d.id
        AND e.provider_user_id=p.provider_user_id AND e.provider_organization_id IS NOT DISTINCT FROM p.provider_organization_id
      WHERE t.id=$1 AND t.universal_contract_version=1 AND t.worker_id IS NULL
        AND t.automation_classification='CONTROLLED_TEST' AND r.outcome='FULFILLMENT_CANDIDATE'
        AND e.task_id IS NULL AND e.task_eligible AND e.valid_until>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id
          AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id
          AND n.decision_version>e.decision_version)
        AND (p.provider_user_id=$2 OR EXISTS(SELECT 1 FROM business_memberships bm WHERE bm.organization_id=p.provider_organization_id
          AND bm.user_id=$2 AND bm.status='ACTIVE' AND bm.role IN('OWNER','ADMIN')))
        AND universal_v1_invited_provider_authority_is_current(e.provider_user_id,e.provider_organization_id,e.provider_class,
          e.trade_credential_id,t.category,t.region_code)
      LIMIT 1`, [taskId, actor]);
    return result.rows[0] ?? null;
  }

  async hold(actor: string, interestId: string): Promise<HoldContext | null> {
    const r = await this.query<HoldContext>(`
      SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,
        d.active_routing_decision_id routing_decision_id,a.hustler_id provider_user_id,a.provider_organization_id,
        e.provider_class,e.trade_credential_id,e.id predecessor_eligibility_id,e.decision_version predecessor_eligibility_version,
        e.valid_until predecessor_valid_until,t.poster_id poster_user_id,a.id interest_application_id,
        e.id eligibility_decision_id,e.decision_version eligibility_version,e.valid_until eligibility_valid_until
      FROM task_applications a JOIN tasks t ON t.id=a.task_id JOIN task_drafts d ON d.task_id=t.id
      JOIN task_scope_versions s ON s.id=t.active_scope_version_id JOIN task_provider_eligibility_decisions e ON e.interest_application_id=a.id
      WHERE a.id=$1 AND t.poster_id=$2 AND a.status='pending' AND e.task_eligible AND e.valid_until>clock_timestamp()
        AND e.scope_version_id=s.id AND e.routing_decision_id=d.active_routing_decision_id
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id
          AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id
          AND n.decision_version>e.decision_version) LIMIT 1`, [interestId, actor]);
    return r.rows[0] ?? null;
  }

  async workOrder(actor: string, holdId: string): Promise<WorkOrderContext | null> {
    const completed = await this.query<WorkOrderContext>(`
      SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,
        w.routing_decision_id,w.provider_user_id,w.provider_organization_id,e.provider_class,e.trade_credential_id,
        e.id predecessor_eligibility_id,e.decision_version predecessor_eligibility_version,e.valid_until predecessor_valid_until,
        t.poster_id poster_user_id,w.interest_application_id,e.id eligibility_decision_id,e.decision_version eligibility_version,
        e.valid_until eligibility_valid_until,h.id conditional_hold_id,h.reserved_at hold_reserved_at,h.expires_at hold_expires_at,
        w.provider_estimate_submission_id,s.customer_total_cents,s.currency
      FROM task_work_orders w JOIN tasks t ON t.id=w.task_id AND t.poster_id=$2 AND t.worker_id IS NULL
      JOIN task_drafts d ON d.id=w.task_draft_id JOIN task_scope_versions s ON s.id=w.scope_version_id
      JOIN task_provider_eligibility_decisions e ON e.id=w.eligibility_decision_id
      JOIN task_reservations h ON h.id=w.conditional_hold_id
      WHERE h.id=$1 LIMIT 1`, [holdId, actor]);
    if (completed.rows[0]) return completed.rows[0];
    const r = await this.query<WorkOrderContext>(`
      SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,
        d.active_routing_decision_id routing_decision_id,a.hustler_id provider_user_id,a.provider_organization_id,
        e.provider_class,e.trade_credential_id,e.id predecessor_eligibility_id,e.decision_version predecessor_eligibility_version,
        e.valid_until predecessor_valid_until,t.poster_id poster_user_id,a.id interest_application_id,
        e.id eligibility_decision_id,e.decision_version eligibility_version,e.valid_until eligibility_valid_until,
        h.id conditional_hold_id,h.reserved_at hold_reserved_at,h.expires_at hold_expires_at,
        m.provider_estimate_submission_id,s.customer_total_cents,s.currency
      FROM task_reservations h JOIN task_applications a ON a.id=h.interest_application_id
      JOIN task_provider_eligibility_decisions e ON e.id=h.eligibility_decision_id
      JOIN tasks t ON t.id=h.task_id JOIN task_drafts d ON d.task_id=t.id
      JOIN task_scope_versions s ON s.id=t.active_scope_version_id
      JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id AND m.scope_version_id=s.id
      WHERE h.id=$1 AND t.poster_id=$2 AND h.status='ACTIVE' AND h.expires_at>clock_timestamp()
        AND e.task_eligible AND e.valid_until>clock_timestamp() AND t.worker_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id
          AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id
          AND n.decision_version>e.decision_version) LIMIT 1`, [holdId, actor]);
    return r.rows[0] ?? null;
  }
}
