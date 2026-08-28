# Backend documentation authority and status register

**Repository role:** index backend team contracts, implementation inventories, runbooks, and frozen evidence without creating business strategy.

**Lifecycle status:** `ACTIVE_DOCUMENTATION / NOT_IMPLEMENTATION_OR_PRODUCTION_AUTHORITY`.

**Canonical authority:** [HustleXP Business and Universal V1 Charter v1.1.0](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/0b80c71e118d7cab70474bbbf6df778811fe4fe8/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md); backend documents are subordinate engineering contracts.

**Supported runtime:** Markdown only; referenced verification scripts use the backend's pinned Node.js 22 toolchain.

**Local start:** no application runtime; begin with `HUSTLEXP_TEAM_ALIGNMENT.md`, then verify claims against the exact repository revision.

**Staging path:** documentation changes follow the signed backend PR and required-check lane; no file in this directory deploys a runtime.

**Payment posture:** documentation cannot enable money; production payment creation, hard assignment, payout, and settlement remain frozen.

**Deployment authority:** none; only protected exact-manifest promotion with approvals and matching runtime provenance can authorize a release.

**Known limitations:** many records are source-dated, proposed, historical, or frozen; their status labels must be read before use.

Status: `CURRENT_DOCUMENTATION_LINE / NOT_IMPLEMENTATION_WORKTREE`

Production effects authorized by this documentation status register: `NONE`

[HUSTLEXP_TEAM_ALIGNMENT.md](HUSTLEXP_TEAM_ALIGNMENT.md) is the stable team target; [HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) is the separately refreshable current-state appendix. The default-branch target becomes team-operative only at an exact commit accepted by an independent Reviewer. Branch and working-copy edits remain review input. Governor state and exact accepted evidence remain authoritative for program workflow and proof.

## Status meanings

| Status                               | Use                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRAFT_REVIEW_INPUT`                 | Unaccepted branch or working-copy proposal; cannot replace the accepted default-branch target.                                                 |
| `PUBLICATION_CANDIDATE_TEAM_TARGET`  | Intended mission whose adoption is resolved only by a separate exact-commit independent-review record.                                         |
| `LOCAL_WORKSPACE_INDEX`              | Local navigation only; not program authority.                                                                                                  |
| `ARCHITECTURE_RECORD_BRANCH`         | Proposed architecture mirror; not implementation authority.                                                                                    |
| `CURRENT_DOCUMENTATION_LINE`         | Maintained documentation worktree; not an implementation destination.                                                                          |
| `CURRENT_TEAM_TARGET`                | Current intended mission; not implementation or production proof.                                                                              |
| `CURRENT_TEAM_TARGET_POINTER`        | Routes readers to the current target and precedence contract.                                                                                  |
| `CURRENT_IMPLEMENTATION_REFERENCE`   | Maintained repository mechanics at a stated revision.                                                                                          |
| `CURRENT_IMPLEMENTATION_INVENTORY`   | Source-dated implementation inventory; not deployment or runtime proof.                                                                        |
| `CURRENT_WORKFLOW_AUTHORITY`         | Binding repository/Governor workflow instructions.                                                                                             |
| `CURRENT_REVIEW_POLICY`              | Blocking review criteria for exact candidates.                                                                                                 |
| `CURRENT_RUNBOOK`                    | May be executed only within its stated authority boundary.                                                                                     |
| `CURRENT_RUNBOOK_TEMPLATE`           | Evidence structure only; a completed exact-bound copy is separate evidence.                                                                    |
| `EXTERNAL_DECISION_REQUIRED`         | Release-blocking boundary that cannot be completed safely without a named external owner choosing and provisioning the stated authority shape. |
| `PROPOSED_NOT_BUILT`                 | Future design or cutover plan.                                                                                                                 |
| `HISTORICAL_IMPLEMENTATION_SNAPSHOT` | Source-dated implementation inventory; verify against exact source before use.                                                                 |
| `HISTORICAL_EVIDENCE`                | Dated observation; never carry its result forward.                                                                                             |
| `FROZEN_EVIDENCE`                    | Immutable evidence; do not edit.                                                                                                               |
| `LEGACY_NON_EXECUTABLE`              | Retained context that must not direct current action.                                                                                          |

The first slash-separated token is the primary status. Qualifiers must use uppercase letters, digits, underscores, or hyphens; they may only narrow or date a status and cannot grant authority. Header and register primary statuses must match.

## Current team and implementation references

| Document                                                                                                                                       | Status                                                                              | Purpose                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `../README.md`                                                                                                                                 | `CURRENT_IMPLEMENTATION_REFERENCE`                                                  | Repository entrypoint and current convergence boundary                                                                 |
| `../AGENTS.md`                                                                                                                                 | `CURRENT_WORKFLOW_AUTHORITY / GOAL_ALIGNMENT_PENDING_SEPARATE_CONTROL_CHANGE`       | Binding repository and Governor workflow instructions; current public-main bytes are not the accepted alignment target |
| `../CLAUDE.md`                                                                                                                                 | `CURRENT_IMPLEMENTATION_REFERENCE / GOAL_ALIGNMENT_PENDING_SEPARATE_CONTROL_CHANGE` | Tool-specific workflow and implementation reference; current public-main bytes retain stale implementation claims      |
| `../.greptile/rules.md`                                                                                                                        | `CURRENT_REVIEW_POLICY / GOAL_ALIGNMENT_PENDING_SEPARATE_CONTROL_CHANGE`            | Existing automated review policy; current public-main bytes still encode the legacy collapsed lifecycle review model   |
| [README.md](README.md)                                                                                                                         | `CURRENT_DOCUMENTATION_LINE / NOT_IMPLEMENTATION_WORKTREE`                          | This documentation authority/status register                                                                           |
| [HUSTLEXP_TEAM_ALIGNMENT.md](HUSTLEXP_TEAM_ALIGNMENT.md)                                                                                       | `CURRENT_TEAM_TARGET / NOT_PRODUCTION_AUTHORITY`                                    | Stable mission, ownership, gates, and objective definition of done                                                     |
| [HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md)                                                               | `CURRENT_IMPLEMENTATION_INVENTORY / SOURCE_DATED / NOT_PRODUCTION_AUTHORITY`        | Refreshable repository, implementation, migration, provider, evidence, and next-action state                           |
| [CONTROLLING_SPEC.md](CONTROLLING_SPEC.md)                                                                                                     | `CURRENT_TEAM_TARGET_POINTER / NOT_PRODUCTION_AUTHORITY`                            | Truth-plane rules and non-negotiable target invariants                                                                 |
| [source-contracts/README.md](source-contracts/README.md)                                                                                       | `FROZEN_EVIDENCE / NOT_PRODUCTION_AUTHORITY`                                        | Byte-preserved backend mission and `/OPS` target inputs with SHA-256 provenance                                        |
| [source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md](source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md) | `FROZEN_EVIDENCE`                                                                   | Exact supplied mission bytes; SHA-256 recorded in the source-contract index                                            |
| [source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md](source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md)                                     | `FROZEN_EVIDENCE`                                                                   | Exact supplied `/OPS` target bytes; SHA-256 recorded in the source-contract index                                      |
| [CI_CD.md](CI_CD.md)                                                                                                                           | `CURRENT_IMPLEMENTATION_REFERENCE`                                                  | Repository checks, release controls, and deployment boundary                                                           |
| [ENV.md](ENV.md)                                                                                                                               | `CURRENT_IMPLEMENTATION_REFERENCE`                                                  | Variable names and capability restrictions                                                                             |
| [MIGRATIONS.md](MIGRATIONS.md)                                                                                                                 | `CURRENT_IMPLEMENTATION_REFERENCE / MIGRATION_SELECTION_HOLD`                       | Migration mechanism and current selection lock                                                                         |
| [architecture/HUSTLEXP_WORK_ORDER_DATABASE_AUTHORITY_BOUNDARY.md](architecture/HUSTLEXP_WORK_ORDER_DATABASE_AUTHORITY_BOUNDARY.md)             | `EXTERNAL_DECISION_REQUIRED / RELEASE_BLOCKING`                                     | Work Order actor-binding, sealed-command, role-provisioning, and live-privilege release hold                           |
| [SCRIPTS.md](SCRIPTS.md)                                                                                                                       | `CURRENT_IMPLEMENTATION_REFERENCE`                                                  | Supported repository scripts                                                                                           |
| `../backend/scripts/README.md`                                                                                                                 | `CURRENT_IMPLEMENTATION_REFERENCE`                                                  | Backend-only script inventory                                                                                          |
| [HustleXP-current-architecture.png](HustleXP-current-architecture.png)                                                                         | `HISTORICAL_IMPLEMENTATION_SNAPSHOT`                                                | Source-dated architecture image; verify before current use                                                             |
| [API_LIST.md](API_LIST.md)                                                                                                                     | `HISTORICAL_IMPLEMENTATION_SNAPSHOT`                                                | Source-dated API inventory; source/router registration wins                                                            |

### Operative-control alignment status

The current local unsigned alignment lineage updates `AGENTS.md` to Node 22 and distinguishes the complete zero-skip `npm run test:required` gate from a diagnostic `npm test` run. Those committed bytes, together with the further dirty review-candidate bytes, have no single accepted signed candidate SHA and must not be represented as published authority.

The same local unsigned lineage aligns `CLAUDE.md` and `.greptile/rules.md` to the provider-neutral Universal V1 lifecycle and removes branch-name auto-merge authority and mutable historical counts. That lineage must be reconstructed with the remaining reviewed bytes into an intentional signed candidate and independently accepted; its existing unsigned commits are evidence, not release authority.

The team is not fully aligned until one exact signed candidate contains the intended operative-control bytes and receives independent acceptance. This register exposes the remaining gate; it does not waive it.

## Proposed convergence records

| Document                                                                                                           | Status                  | Purpose                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| [architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md](architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md) | `PROPOSED_NOT_BUILT`    | Detailed processor-neutral transaction and `/OPS` target         |
| [SUPABASE_TO_RAILWAY_CUTOVER.md](SUPABASE_TO_RAILWAY_CUTOVER.md)                                                   | `PROPOSED_NOT_BUILT`    | Overlay inventory and staged cutover plan                        |
| [templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md](templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md)                   | `LEGACY_NON_EXECUTABLE` | Expired role-fixture packaging template retained as design input |

## Evidence and legacy operations material

| Document                                                                                             | Status                                        | Rule                                                                              |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| [production-role-readiness-evidence-2026-07-22.md](production-role-readiness-evidence-2026-07-22.md) | `FROZEN_EVIDENCE`                             | Preserve bytes; dated `NO-GO` observation only                                    |
| `../ops/runbooks/EPIC03_KILL_SWITCH_EVIDENCE.md`                                                     | `FROZEN_EVIDENCE`                             | Preserve bytes; dated observation only                                            |
| `../ops/runbooks/BACKUP_RESTORE_EVIDENCE_TEMPLATE.md`                                                | `CURRENT_RUNBOOK_TEMPLATE`                    | Local template; completed, exact-revision receipts are separate evidence          |
| `../ops/runbooks/RAILWAY_POSTGRES_PITR_ENABLE.md`                                                    | `CURRENT_RUNBOOK / PROD_GATED`                | No provider click, wake, redeploy, or deletion without fresh authority            |
| `../ops/runbooks/EPIC02_LIVEOPS_EXECUTION.md`                                                        | `HISTORICAL_EVIDENCE`                         | Prior execution package; not current authority                                    |
| `../ops/runbooks/EPIC02_OPERATOR_CHECKLIST.md`                                                       | `HISTORICAL_EVIDENCE`                         | Prior operator checklist; not current authority                                   |
| `../ops/runbooks/EPIC03_TEST_MODE_CERT_STEPS.md`                                                     | `HISTORICAL_EVIDENCE`                         | Legacy Stripe test receipts; no processor approval                                |
| `../ops/runbooks/EPIC03_PAYMENT_UNFREEZE_GATE.md`                                                    | `LEGACY_NON_EXECUTABLE`                       | Superseded; no unfreeze path is authorized                                        |
| `../ops/runbooks/PAYMENT_CERTIFICATION_CHECKLIST.md`                                                 | `HISTORICAL_EVIDENCE / LEGACY_NON_EXECUTABLE` | Historical processor receipts; not certification for the target lifecycle         |
| `../ops/runbooks/EPIC04_ROLE_FIXTURE_EXECUTION.md`                                                   | `LEGACY_NON_EXECUTABLE`                       | Expired production-fixture instructions                                           |
| `../ops/runbooks/production-launch-checklist.md`                                                     | `CURRENT_RUNBOOK / NO_GO_GATE`                | Blocking launch gate; contains no enablement procedure                            |
| `../ops/compliance/production-legal-approval-handoff.md`                                             | `CURRENT_RUNBOOK / PENDING_COUNSEL`           | Legal decision packet; not legal advice or approval                               |
| `../ops/compliance/1099-threshold-tracking.md`                                                       | `PROPOSED_NOT_BUILT`                          | Counsel/processor decision and canonical data requirements                        |
| `../ops/compliance/pci-saq-a-checklist.md`                                                           | `PROPOSED_NOT_BUILT`                          | Acquirer/processor/assessor scope decision and baseline engineering controls      |
| `../ops/compliance/tos-version-tracking.md`                                                          | `PROPOSED_NOT_BUILT`                          | Counsel-approved policy registry and acceptance contract                          |
| `../ops/security/pentest-playbook.md`                                                                | `PROPOSED_NOT_BUILT`                          | Processor-neutral test target; requires authorized staging and independent tester |

## Preservation rules

1. Do not edit Governor control, underwriting source locks, accepted/rejected proof bundles, content-addressed evidence, or frozen evidence.
2. A dated `PROVEN` result proves only the recorded boundary and observation time.
3. A current runbook states required authority and cannot convert `NO-GO` into permission.
4. A target design never proves runtime wiring, migration, provider approval, deployment, or business health.
5. Regenerate inventories and metrics from an exact SHA; never update only the prose count.
