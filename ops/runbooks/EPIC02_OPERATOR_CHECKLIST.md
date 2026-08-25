> Documentation status: `HISTORICAL_EVIDENCE / NON_AUTHORIZING`
>
> This 2026-07-27 body is preserved verbatim for provenance. Provider state, owners, plans, and permissions must be re-established; no external action is authorized here.

# EPIC-02 Operator Checklist (parallel to apex TLS)

**As of:** 2026-07-27  
**Goal:** Close “configured but unproven” for backups, alerts, and severe-edge ownership.  
**Does not require:** apex TLS / 24/24.

## Inventory already in-repo

| Asset | Path | Local status |
| --- | --- | --- |
| Alert rules | `ops/alerts/critical.yml` | Present (money, availability, pool) |
| Launch checklist | `ops/runbooks/production-launch-checklist.md` | Present |
| Backup/restore template | `ops/runbooks/BACKUP_RESTORE_EVIDENCE_TEMPLATE.md` | Present — unfilled |
| Live-ops execution | `ops/runbooks/EPIC02_LIVEOPS_EXECUTION.md` | Present |

## Operator actions (external consoles)

Complete and attach evidence links (no secrets in git):

1. **Railway Postgres (canonical engine DB)** — enable PITR on the Postgres service Backups tab; wait for first base backup; run restore-to-new-service drill; record RPO/RTO. Procedure: `RAILWAY_POSTGRES_PITR_ENABLE.md`.
2. **Redis (Railway / Upstash)** — confirm persistence/backup posture; document recovery steps.
3. **Supabase** — confirm PITR for overlay DB; note retention; optional restore drill.
4. **Alert delivery** — wire `ops/alerts/critical.yml` (or equivalent) to a real receiver; fire one test alert; capture ack timestamp.
5. **Severe-edge roster** — name primary/backup for safety, fraud, payments, privacy, legal, DNS/release, communications.

## Acceptance (EPIC-02 done only when)

- [ ] Measured RPO/RTO attached for engine Postgres  
- [ ] At least one restore drill evidence path recorded  
- [ ] At least one real alert delivery + ack recorded  
- [ ] Seven-lane severe-edge roster filled and current  

Until then status remains **FAILED / unproven**, even if alert YAML exists.

## Deferral note (2026-07-27)

Railway native Backups/PITR requires **Pro plan** (confirmed in UI: “No Backups”).  
**Decision:** skip native PITR for now. EPIC-02 backup rows stay open; continue other launch work. Revisit when Pro is available.
