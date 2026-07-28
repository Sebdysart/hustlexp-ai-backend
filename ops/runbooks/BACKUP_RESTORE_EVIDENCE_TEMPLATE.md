# Backup / Restore Evidence Template (EPIC-02)

Complete one row per datastore. Do not claim backup readiness from configuration presence alone.

## Datastores

| Store | Provider | Backup / PITR enabled | Retention | Last successful backup (UTC) | Restore drill at (UTC) | Measured RPO | Measured RTO | Evidence link | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Engine Postgres (Railway) | Railway Postgres + PITR | | ~4 weeks base retention (per Railway PITR) | | | | | | |
| Upstash Redis | | | | | | | | | |
| Supabase Postgres | | | | | | | | | |
| Supabase storage (if used for proof media) | | | | | | | | | |

## Restore drill procedure

1. Select a non-destructive restore target (fork / temporary project).
2. Restore to a timestamp after the last known good migration.
3. Record: source revision, migration version, row-count spot checks for `tasks`, `escrows`, `users`.
4. Bind evidence to exact engine revision and site revision under test.
5. Delete the temporary restore target after evidence capture.

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
| Payment / Stripe | | | |
| Privacy / data | | | |
| Legal | | | |
| DNS / release | | | |
| Communications (Twilio/SendGrid) | | | |

## Acceptance

- Measured RPO/RTO attached
- At least one restore drill with revision binding
- At least one real alert delivery (not config-only)
- Named severe-edge roster current within 30 days
