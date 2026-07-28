# Controlling product specification

The autonomous platform target contract lives in the site repository:

`Sebdysart/hustlexp-site` → `docs/production/HUSTLEXP_AUTONOMOUS_LOCAL_WORK_PLATFORM_FINAL_SPEC.md`

Engine work must preserve:

1. Railway/Postgres as canonical task/payment/dispatch/settlement truth
2. Supabase as overlay only (attribution, communications, recovery, analytics, ops projections)
3. AI advisory — deterministic services for money, assignment, address, credentials
4. Payment freeze until EPIC-03 receipts + kill switch are proven

Related local runbooks:

- `ops/runbooks/BACKUP_RESTORE_EVIDENCE_TEMPLATE.md` (EPIC-02)
- `ops/runbooks/PAYMENT_CERTIFICATION_CHECKLIST.md` (EPIC-03)
- `docs/templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md` (EPIC-04)
