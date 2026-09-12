# Backup / Restore Evidence Template (EPIC-02)

Status: `CURRENT_RUNBOOK_TEMPLATE / EXECUTION_REQUIRES_EXACT_AUTHORITY`

Production effects authorized by this template: `NONE`

Read [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md). Provider-console clicks, restore creation, database connections, temporary-service deletion, or alert delivery require the effect mode and authority applicable to the exact target. A filled template is not evidence until receipts are bound to exact source, store, backup, restore, and reviewer identities.

Complete one row per datastore. Do not claim backup readiness from configuration presence alone.

## Datastores

| Store | Provider | Backup / PITR enabled | Retention | Last successful backup (UTC) | Restore drill at (UTC) | Measured RPO | Measured RTO | Evidence link | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Engine Postgres (Railway) | | | | | | | | | |
| Upstash Redis | | | | | | | | | |
| Supabase Postgres | | | | | | | | | |
| Supabase storage (if used for proof media) | | | | | | | | | |

## Restore drill procedure

1. Select a non-destructive restore target (fork / temporary project).
2. Restore to a timestamp after the last known good migration.
3. Record the exact source deployment, database identity, migration ledger, restore point, and schema fingerprint.
4. Compare canonical task roots, financial-security records where present, payment operations, append-only ledger/audit rows, inbox/outbox positions, settlement/funding/payout/reconciliation records where present, identity links, and required overlay pointers. Legacy `escrows` are historical compatibility evidence, not aggregate payment truth.
5. Bind evidence to the exact engine, site, worker, schema, backup, and restored-database identities under test.
6. Delete the temporary restore target only under separate explicit authority after evidence capture and preservation.

## Alert delivery drill

| Alert | Receiver | Fired at (UTC) | Acknowledged at | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Engine `/health` fail | | | | | |
| Payment freeze / kill switch | | | | | |
| Worker DLQ growth | | | | | |
| Certificate expiry | | | | | |

## Severe-edge roster

| Lane | Primary | Backup | Escalation |
| --- | --- | --- | --- |
| Safety / violence | | | |
| Fraud / identity | | | |
| Financial operations / processor / reconciliation | | | |
| Privacy / data | | | |
| Legal | | | |
| DNS / release | | | |
| Communications (Twilio/SendGrid) | | | |

## Acceptance

- Measured RPO/RTO attached
- At least one restore drill with revision binding
- At least one real alert delivery (not config-only)
- Named severe-edge roster current within 30 days
- Independent reviewer confirms the restored facts reconcile and no source store or production pointer was mutated
