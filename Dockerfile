# HustleXP Backend Dockerfile
# Multi-stage build for production optimization

# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies only when needed
COPY package.json package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

ARG HX_BUILD_REVISION=""
ARG HX_BUILD_SOURCE_CLEAN=""
ARG HX_BUILD_TIMESTAMP=""
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GITHUB_SHA=""
ARG SOURCE_VERSION=""
ENV HX_BUILD_ENVIRONMENT=production \
    HX_BUILD_REVISION=$HX_BUILD_REVISION \
    HX_BUILD_SOURCE_CLEAN=$HX_BUILD_SOURCE_CLEAN \
    HX_BUILD_TIMESTAMP=$HX_BUILD_TIMESTAMP \
    RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA \
    GITHUB_SHA=$GITHUB_SHA \
    SOURCE_VERSION=$SOURCE_VERSION

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run compile

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 hustlexp

# Copy only necessary files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/Procfile ./Procfile
COPY --from=builder /app/backend/database/constitutional-schema.sql ./backend/database/constitutional-schema.sql
COPY --from=builder /app/backend/database/migrations/add_missing_tables_v2.sql ./backend/database/migrations/add_missing_tables_v2.sql
COPY --from=builder /app/backend/database/migrations/20260710_engine_automation_contracts.sql ./backend/database/migrations/20260710_engine_automation_contracts.sql
COPY --from=builder /app/backend/database/migrations/011-proof-alignment.sql ./backend/database/migrations/011-proof-alignment.sql
COPY --from=builder /app/backend/database/migrations/expertise_supply_control.sql ./backend/database/migrations/expertise_supply_control.sql
COPY --from=builder /app/backend/database/migrations/20260711_task_outcome_classification.sql ./backend/database/migrations/20260711_task_outcome_classification.sql
COPY --from=builder /app/backend/database/migrations/20260712_hustler_identity_link.sql ./backend/database/migrations/20260712_hustler_identity_link.sql
COPY --from=builder /app/backend/database/migrations/20260712_dispatch_expiry_pending_payment_cancel.sql ./backend/database/migrations/20260712_dispatch_expiry_pending_payment_cancel.sql
COPY --from=builder /app/backend/database/migrations/20260712_dispatch_expiry_no_payment_reconcile.sql ./backend/database/migrations/20260712_dispatch_expiry_no_payment_reconcile.sql
COPY --from=builder /app/backend/database/migrations/20260713_performance_indexes_alignment.sql ./backend/database/migrations/20260713_performance_indexes_alignment.sql
COPY --from=builder /app/backend/database/migrations/chargeback_lifecycle.sql ./backend/database/migrations/chargeback_lifecycle.sql
COPY --from=builder /app/backend/database/migrations/20260718_revenue_audit_rail.sql ./backend/database/migrations/20260718_revenue_audit_rail.sql
COPY --from=builder /app/backend/database/migrations/20260718_quote_economics_contract.sql ./backend/database/migrations/20260718_quote_economics_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_scope_versions.sql ./backend/database/migrations/20260718_task_scope_versions.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_location_encryption.sql ./backend/database/migrations/20260718_task_location_encryption.sql
COPY --from=builder /app/backend/database/migrations/20260718_proof_submission_atomicity.sql ./backend/database/migrations/20260718_proof_submission_atomicity.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_safety_incident_cases.sql ./backend/database/migrations/20260718_task_safety_incident_cases.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_safety_delivery_contract.sql ./backend/database/migrations/20260718_task_safety_delivery_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_safety_checkins.sql ./backend/database/migrations/20260718_task_safety_checkins.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_safety_location_encryption.sql ./backend/database/migrations/20260718_task_safety_location_encryption.sql
COPY --from=builder /app/backend/database/migrations/20260718_zone_category_liquidity_cells.sql ./backend/database/migrations/20260718_zone_category_liquidity_cells.sql
COPY --from=builder /app/backend/database/migrations/20260718_worker_offer_decision_contract.sql ./backend/database/migrations/20260718_worker_offer_decision_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_worker_screening_rights_contract.sql ./backend/database/migrations/20260718_worker_screening_rights_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_region_policy_contract.sql ./backend/database/migrations/20260718_region_policy_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_completion_retention_contract.sql ./backend/database/migrations/20260718_completion_retention_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_task_public_clarifications.sql ./backend/database/migrations/20260718_task_public_clarifications.sql
COPY --from=builder /app/backend/database/migrations/20260718_marketplace_reputation_contract.sql ./backend/database/migrations/20260718_marketplace_reputation_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_business_workspace_contract.sql ./backend/database/migrations/20260718_business_workspace_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_business_operations_contract.sql ./backend/database/migrations/20260718_business_operations_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_business_execution_contract.sql ./backend/database/migrations/20260718_business_execution_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_recurring_work_contract.sql ./backend/database/migrations/20260718_recurring_work_contract.sql
COPY --from=builder /app/backend/database/migrations/20260718_business_recurring_contract.sql ./backend/database/migrations/20260718_business_recurring_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_recommendation_contract.sql ./backend/database/migrations/20260719_recommendation_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_hustler_wallet_contract.sql ./backend/database/migrations/20260719_hustler_wallet_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_wallet_provider_event_integrity.sql ./backend/database/migrations/20260719_wallet_provider_event_integrity.sql
COPY --from=builder /app/backend/database/migrations/20260719_wallet_provider_event_integrity_repair.sql ./backend/database/migrations/20260719_wallet_provider_event_integrity_repair.sql
COPY --from=builder /app/backend/database/migrations/20260719_lifecycle_service_foundations.sql ./backend/database/migrations/20260719_lifecycle_service_foundations.sql
COPY --from=builder /app/backend/database/migrations/20260719_task_worker_eligibility_contract.sql ./backend/database/migrations/20260719_task_worker_eligibility_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_append_only_truncate_contract.sql ./backend/database/migrations/20260719_append_only_truncate_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_admin_user_search_trigram_contract.sql ./backend/database/migrations/20260719_admin_user_search_trigram_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_admin_capability_contract.sql ./backend/database/migrations/20260719_admin_capability_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_tier0_browse_only_contract.sql ./backend/database/migrations/20260719_tier0_browse_only_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_task_template_policy_contract.sql ./backend/database/migrations/20260719_task_template_policy_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_compliance_guardian_persistence_contract.sql ./backend/database/migrations/20260719_compliance_guardian_persistence_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_worker_offer_retake_contract.sql ./backend/database/migrations/20260719_worker_offer_retake_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_liquidity_expansion_contract.sql ./backend/database/migrations/20260719_liquidity_expansion_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_liquidity_expansion_fk_repair.sql ./backend/database/migrations/20260719_liquidity_expansion_fk_repair.sql
COPY --from=builder /app/backend/database/migrations/20260719_worker_counter_offer_contract.sql ./backend/database/migrations/20260719_worker_counter_offer_contract.sql
COPY --from=builder /app/backend/database/migrations/20260719_worker_counter_offer_exclusivity.sql ./backend/database/migrations/20260719_worker_counter_offer_exclusivity.sql
COPY --from=builder /app/backend/database/migrations/20260719_external_task_bridge_contract.sql ./backend/database/migrations/20260719_external_task_bridge_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_task_geofence_event_contract.sql ./backend/database/migrations/20260720_task_geofence_event_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_major_action_telemetry_contract.sql ./backend/database/migrations/20260720_major_action_telemetry_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_major_action_telemetry_contract_repair.sql ./backend/database/migrations/20260720_major_action_telemetry_contract_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_major_action_source_registry_repair.sql ./backend/database/migrations/20260720_major_action_source_registry_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_offline_action_sync_contract.sql ./backend/database/migrations/20260720_offline_action_sync_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_offline_action_sync_contract_repair.sql ./backend/database/migrations/20260720_offline_action_sync_contract_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_proof_verification_signal_contract.sql ./backend/database/migrations/20260720_proof_verification_signal_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_proof_media_metadata_minimization.sql ./backend/database/migrations/20260720_proof_media_metadata_minimization.sql
COPY --from=builder /app/backend/database/migrations/20260720_media_upload_finalization_contract.sql ./backend/database/migrations/20260720_media_upload_finalization_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_private_media_delivery_contract.sql ./backend/database/migrations/20260720_private_media_delivery_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_worker_standing_appeals.sql ./backend/database/migrations/20260720_worker_standing_appeals.sql
COPY --from=builder /app/backend/database/migrations/20260720_offline_action_reconciliation.sql ./backend/database/migrations/20260720_offline_action_reconciliation.sql
COPY --from=builder /app/backend/database/migrations/20260720_dispute_release_authority_contract.sql ./backend/database/migrations/20260720_dispute_release_authority_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_notification_delivery_contract.sql ./backend/database/migrations/20260720_notification_delivery_contract.sql
COPY --from=builder /app/backend/database/migrations/20260720_notification_delivery_contract_repair.sql ./backend/database/migrations/20260720_notification_delivery_contract_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_notification_focus_suppression.sql ./backend/database/migrations/20260720_notification_focus_suppression.sql
COPY --from=builder /app/backend/database/migrations/20260720_schema_convergence_repair.sql ./backend/database/migrations/20260720_schema_convergence_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_local_certification_payment_provider.sql ./backend/database/migrations/20260720_local_certification_payment_provider.sql
COPY --from=builder /app/backend/database/migrations/20260720_region_policy_price_book_alignment.sql ./backend/database/migrations/20260720_region_policy_price_book_alignment.sql
COPY --from=builder /app/backend/database/migrations/20260720_local_certification_payout_provider.sql ./backend/database/migrations/20260720_local_certification_payout_provider.sql
COPY --from=builder /app/backend/database/migrations/20260720_local_certification_screening_provider.sql ./backend/database/migrations/20260720_local_certification_screening_provider.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_liquidity_cell.sql ./backend/database/migrations/20260720_controlled_test_liquidity_cell.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_liquidity_marker_repair.sql ./backend/database/migrations/20260720_controlled_test_liquidity_marker_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_liquidity_lifecycle_repair.sql ./backend/database/migrations/20260720_controlled_test_liquidity_lifecycle_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_duration_evidence.sql ./backend/database/migrations/20260720_controlled_test_duration_evidence.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_provider_capability.sql ./backend/database/migrations/20260720_controlled_test_provider_capability.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_provider_capability_expiry.sql ./backend/database/migrations/20260720_controlled_test_provider_capability_expiry.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_provider_capability_refresh.sql ./backend/database/migrations/20260720_controlled_test_provider_capability_refresh.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_provider_capability_refresh_repair.sql ./backend/database/migrations/20260720_controlled_test_provider_capability_refresh_repair.sql
COPY --from=builder /app/backend/database/migrations/20260720_controlled_test_offer_review.sql ./backend/database/migrations/20260720_controlled_test_offer_review.sql
COPY --from=builder /app/backend/database/migrations/20260720_task_safety_state_integrity.sql ./backend/database/migrations/20260720_task_safety_state_integrity.sql
COPY --from=builder /app/backend/database/migrations/20260720_task_safety_resolution_integrity.sql ./backend/database/migrations/20260720_task_safety_resolution_integrity.sql
COPY --from=builder /app/backend/database/migrations/20260720_task_safety_case_access_integrity.sql ./backend/database/migrations/20260720_task_safety_case_access_integrity.sql
COPY --from=builder /app/backend/database/migrations/20260720_operations_exception_contract.sql ./backend/database/migrations/20260720_operations_exception_contract.sql
COPY --from=builder /app/backend/database/migrations/20260721_hustler_trust_progression_contract.sql ./backend/database/migrations/20260721_hustler_trust_progression_contract.sql
COPY --from=builder /app/backend/database/migrations/20260721_task_quote_shortlist_messaging_contract.sql ./backend/database/migrations/20260721_task_quote_shortlist_messaging_contract.sql
COPY --from=builder /app/backend/database/migrations/20260721_unit_economics_guardrails.sql ./backend/database/migrations/20260721_unit_economics_guardrails.sql
COPY --from=builder /app/backend/database/migrations/20260721_build_now_spend_promotion_guardrails.sql ./backend/database/migrations/20260721_build_now_spend_promotion_guardrails.sql
COPY --from=builder /app/backend/database/migrations/20260721_private_identity_verification_contract.sql ./backend/database/migrations/20260721_private_identity_verification_contract.sql
COPY --from=builder /app/backend/database/migrations/20260721_sensitive_media_ingestion_shutdown.sql ./backend/database/migrations/20260721_sensitive_media_ingestion_shutdown.sql
COPY --from=builder /app/backend/database/migrations/20260721_ai_observability_contract.sql ./backend/database/migrations/20260721_ai_observability_contract.sql
COPY --from=builder /app/backend/database/migrations/20260721_controlled_test_retake_acceptance_repair.sql ./backend/database/migrations/20260721_controlled_test_retake_acceptance_repair.sql
COPY --from=builder /app/backend/database/migrations/20260721_controlled_test_retake_liquidity_repair.sql ./backend/database/migrations/20260721_controlled_test_retake_liquidity_repair.sql
COPY --from=builder /app/backend/database/migrations/20260721_controlled_test_retake_guard_convergence.sql ./backend/database/migrations/20260721_controlled_test_retake_guard_convergence.sql
COPY --from=builder /app/backend/database/migrations/20260721_same_worker_retake_assignment_guard_repair.sql ./backend/database/migrations/20260721_same_worker_retake_assignment_guard_repair.sql

# Change ownership
RUN chown -R hustlexp:nodejs /app
USER hustlexp

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "if(process.env.SERVICE_ROLE==='worker'){process.exit(0)}require('http').get('http://localhost:3000/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
