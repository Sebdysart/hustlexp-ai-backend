# EPIC-02 — Live-ops execution package

**Status:** FAILED (templates ready; restore/alert drills not proven in-session)

## Deliverables in-repo

- `BACKUP_RESTORE_EVIDENCE_TEMPLATE.md`
- Existing `ops/alerts/` + `ops/runbooks/production-launch-checklist.md`
- Prometheus config under `infrastructure/prometheus/`

## Required operator actions (authority)

1. Enable Railway Postgres PITR (see `RAILWAY_POSTGRES_PITR_ENABLE.md`) + Redis recovery note + Supabase PITR for overlay.
2. Execute one restore drill into a temporary project; record RPO/RTO.
3. Fire one real critical alert to the on-call receiver; capture ack timestamp.
4. Fill severe-edge roster in the backup template.
5. Attach evidence paths into site `artifacts/production/` and refresh current-state.

## Acceptance

Measured RPO/RTO + restore evidence + alert delivery + named roster. Configuration presence alone is insufficient.
