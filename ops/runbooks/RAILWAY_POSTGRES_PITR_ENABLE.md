# Railway Postgres PITR enablement (EPIC-02)

Status: `CURRENT_RUNBOOK / PROD_GATED_EXTERNAL_EFFECTS`

Production effects authorized by this document: `NONE`

Do not perform any step below until a fresh execution session has exact root-specific authority for the named Railway project, environment, service, provider actions, expected redeploy, evidence capture, and cleanup. Re-read current provider documentation and state before execution; the 2026-07-27 observations below are historical. See [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md).

**Canonical datastore:** Railway PostgreSQL (not Neon).  
**Docs:** https://docs.railway.com/volumes/point-in-time-recovery  

This is the production backup path for the engine DB.

## Current status (2026-07-27)

**BLOCKED_EXTERNAL / deferred:** Railway Backups tab shows *“Backups and point-in-time recovery (PITR) are only available for customers on the Pro plan.”* and *“No Backups.”*  
Native PITR is **skipped until Pro is purchased**. Do not claim EPIC-02 backup acceptance until then.

## Prerequisites

- Railway project with an official Postgres service (`ghcr.io/railwayapp-templates/postgres-ssl` pinned to a **major** tag, e.g. `:16` / `:17` / `:18` — not `:latest`, not a minor pin like `:16.10`).
- Volume attached to that Postgres service.
- Account plan that supports backups/PITR (typically Pro).
- If **Enable PITR** is missing: turn on the PITR feature flag at https://railway.com/account/feature-flags

## Enable (operator click — requires fresh authority)

1. Open Railway → project **HustleXP** / production environment.
2. Click the **Postgres** database service (not `hustlexp-ai-backend`, not Redis).
3. Open the **Backups** tab.
4. If you see **Point-in-time recovery is off**, click **Enable PITR** → confirm.
5. Railway will:
   - create a **Postgres-PITR** storage bucket
   - set `WAL_ARCHIVE_*` vars on Postgres
   - redeploy Postgres
6. Wait until the Backups tab shows a healthy PITR window / datetime picker (first base backup is automatic after enable — can take several minutes).

**Safety:** enabling PITR redeploys Postgres briefly. Do this in a maintenance-friendly window; keep payment freeze on.

## Prove restore (required for EPIC-02)

1. On **Backups**, pick a timestamp after the first base backup.
2. Click **Restore to this moment**.
3. Railway creates a **new** sibling service `…-restored-YYYYMMDD-HHMM` — **prod Postgres is not overwritten**.
4. Record:
   - restore clicked at (UTC)
   - restored service healthy at (UTC) → **RTO**
   - that prod kept serving → note “source untouched”
5. Spot-check the fork (row counts / `\dt`) without pointing production `DATABASE_URL` at it.
6. Preserve the evidence, then request or use separate explicit cleanup authority before deleting the restored fork.

## Evidence to paste back (no secrets)

```text
Railway Postgres image tag:
PITR enabled: yes/no
First base backup visible: yes/no
Restore drill: yes/no
Restore started (UTC):
Restore ready (UTC):
Approx RTO:
Prod DATABASE_URL unchanged: yes
```

## CLI (optional, after `railway login`)

```bash
railway login
railway link   # select project + Postgres service
railway status
```

PITR enable/restore is still primarily a **Backups tab** action; CLI is for status/linking, not a substitute for Enable PITR.
