# Terms of Service Version Tracking

**Purpose:** Track TOS versions, user acceptance, and change notifications
**Legal Requirement:** Users must affirmatively accept current TOS before transacting
**Last Updated:** 2025-02-21

---

## Current TOS Version

| Field | Value |
|-------|-------|
| Version | 1.0.0 |
| Effective Date | 2025-02-01 |
| File | public/terms-of-service.html |
| Route | /terms-of-service, /terms |

---

## Database Schema (Planned)

```sql
-- TOS version history
CREATE TABLE IF NOT EXISTS tos_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version VARCHAR(20) NOT NULL UNIQUE,
  effective_date DATE NOT NULL,
  summary_of_changes TEXT,
  requires_re_acceptance BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User acceptance records
CREATE TABLE IF NOT EXISTS tos_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tos_version_id UUID NOT NULL REFERENCES tos_versions(id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT,
  UNIQUE(user_id, tos_version_id)
);

-- Index for quick lookup
CREATE INDEX idx_tos_acceptances_user_version
  ON tos_acceptances(user_id, tos_version_id);
```

---

## Enforcement Logic (Planned)

```typescript
// Middleware: Check TOS acceptance before financial transactions
async function requireCurrentTOS(userId: string): Promise<boolean> {
  const currentTOS = await db.query(
    `SELECT id FROM tos_versions
     WHERE effective_date <= NOW()
     ORDER BY effective_date DESC LIMIT 1`
  );

  if (!currentTOS.rows[0]) return true; // No TOS configured

  const acceptance = await db.query(
    `SELECT 1 FROM tos_acceptances
     WHERE user_id = $1 AND tos_version_id = $2`,
    [userId, currentTOS.rows[0].id]
  );

  return acceptance.rows.length > 0;
}
```

---

## Version Change Process

1. **Draft** new TOS version
2. **Legal review** and approval
3. **Insert** new row in `tos_versions` table
4. **Set** `requires_re_acceptance = true` if material changes
5. **Deploy** updated HTML to `/terms-of-service`
6. **Notify** all active users via email + in-app banner
7. **Block** financial transactions for users who haven't re-accepted (if required)
8. **Log** acceptance timestamps and IP addresses for compliance records

---

## Audit Trail

All TOS acceptances are immutable records with:
- User ID
- TOS version ID
- Timestamp (server time, not client)
- IP address (for legal defensibility)
- User agent (browser identification)

Records are never deleted, even if user account is deleted (legal hold requirement).
